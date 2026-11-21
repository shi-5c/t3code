import * as HostProcess from "@t3tools/shared/HostProcess";
import * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { buildCodexInitializeParams } from "../CodexProvider.ts";

const ConnectorPath = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.NullOr(Schema.String)),
);

const READ_CONNECTOR = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'T3Code\CodexDesktopShare'
function Get-Connector {
  for ($directory = [IO.DirectoryInfo]::new($root); $null -ne $directory; $directory = $directory.Parent) {
    if ($directory.Exists -and ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
  }
  $journalFile = Get-Item -LiteralPath (Join-Path $root 'transaction.json') -ErrorAction SilentlyContinue
  if (!$journalFile -or $journalFile.Length -gt 16384 -or ($journalFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
  $journal = [IO.File]::ReadAllText($journalFile.FullName) | ConvertFrom-Json
  if ($journal.version -ne 1 -or $journal.phase -cne 'forwarding' -or
      $journal.id -cnotmatch '^[a-f0-9]{32}$' -or $journal.imageHash -cnotmatch '^[0-9A-F]{64}$') { return }
  $candidate = Join-Path $root ('forward-' + $journal.id + '.exe')
  $registry = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  if (!$registry) { return }
  try {
    if ($registry.GetValue('CODEX_CLI_PATH') -cne $candidate -or $registry.GetValueKind('CODEX_CLI_PATH') -ne 'String') { return }
  } finally { $registry.Dispose() }
  $binary = Get-Item -LiteralPath $candidate -ErrorAction SilentlyContinue
  $endpoint = Get-Item -LiteralPath ([IO.Path]::ChangeExtension($candidate, '.endpoint')) -ErrorAction SilentlyContinue
  if (!$binary -or ($binary.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      !$endpoint -or ($endpoint.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -cne $journal.imageHash) { return }
  return $candidate
}
ConvertTo-Json -InputObject (Get-Connector) -Compress
`;

export const locateDesktopShareConnector = Effect.fn("CodexDesktopShare.locateConnector")(
  function* () {
    if ((yield* HostProcess.Platform) !== "win32") return null;
    const environment = yield* HostProcess.Environment;
    const systemRoot = environment.SystemRoot ?? environment.WINDIR;
    if (!systemRoot) return null;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner
      .string(
        ChildProcess.make(
          `${systemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe`,
          ["-NoProfile", "-NonInteractive", "-Command", READ_CONNECTOR],
          { stdin: "ignore", stderr: "ignore" },
        ),
      )
      .pipe(
        Effect.flatMap(ConnectorPath),
        Effect.timeout("8 seconds"),
        Effect.orElseSucceed(() => null),
      );
  },
);

export const openDesktopShareClient = Effect.fn("CodexDesktopShare.openClient")(function* (
  connector: string,
  options?: CodexClient.CodexAppServerClientOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const process = yield* spawner.spawn(
    ChildProcess.make(connector, ["--t3-desktop-share-connect"], { shell: false }),
  );
  const context = yield* Layer.build(CodexClient.layerChildProcess(process, options));
  return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context));
});

const LifecycleResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.Literals([
        "Ready",
        "Forwarding",
        "Configured",
        "RestartPending",
        "Conflict",
        "Restored",
        "Unconfigured",
      ]),
      version: Schema.optionalKey(Schema.String),
      userOverridePresent: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);

class DesktopShareHostError extends Schema.TaggedError<DesktopShareHostError>()(
  "DesktopShareHostError",
  { message: Schema.String },
) {}

export const runDesktopShareLifecycle = Effect.fn("CodexDesktopShare.runLifecycle")(function* (
  action: "Preflight" | "Enable" | "Status" | "Restore",
) {
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  if (platform !== "win32" || arch !== "x64") {
    return yield* new DesktopShareHostError({
      message: "Codex Desktop Share requires a Windows x64 T3 host.",
    });
  }
  const env = yield* HostProcess.Environment;
  const systemRoot = env.SystemRoot ?? env.WINDIR;
  if (!systemRoot) {
    return yield* new DesktopShareHostError({ message: "Windows PowerShell was not found." });
  }
  const path = yield* Path.Path;
  const script =
    env.T3CODE_DESKTOP_SHARE_SCRIPT ??
    (yield* path
      .fromFileUrl(
        new URL("../../../../../native/codex-desktop-share/CodexDesktopShare.ps1", import.meta.url),
      )
      .pipe(
        Effect.mapError(
          () =>
            new DesktopShareHostError({
              message: "The Codex Desktop bridge scripts are unavailable on this host.",
            }),
        ),
      ));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .string(
      ChildProcess.make(
        path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-Action",
          action,
          "-Share",
        ],
        { shell: false, stdin: "ignore", stderr: "ignore" },
      ),
    )
    .pipe(
      Effect.flatMap(LifecycleResult),
      Effect.mapError(
        () =>
          new DesktopShareHostError({
            message:
              action === "Enable"
                ? "Codex Desktop could not start sharing. Check the bridge status before retrying."
                : action === "Restore"
                  ? "Codex Desktop could not be restored. Check the bridge status and retry."
                  : "The Codex Desktop bridge could not be checked on this host.",
          }),
      ),
    );
});

export const openDesktopShareReader = Effect.fn("CodexDesktopShare.openReader")(function* () {
  const connector = yield* locateDesktopShareConnector();
  if (!connector) {
    return yield* new DesktopShareHostError({
      message: "Open Codex Desktop to restore the shared connection.",
    });
  }
  const client = yield* openDesktopShareClient(connector, {
    acceptServerRequest: () => Effect.succeed(false),
  });
  yield* client.request("initialize", buildCodexInitializeParams());
  yield* client.notify("initialized", undefined);
  return client;
});

export const checkDesktopShareConnection = Effect.fn("CodexDesktopShare.checkConnection")(
  function* () {
    return yield* openDesktopShareReader().pipe(
      Effect.scoped,
      Effect.interruptible,
      Effect.timeout("12 seconds"),
      Effect.retry({ times: 2, schedule: Schedule.spaced("1 second") }),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  },
);
