import * as HostProcess from "@t3tools/shared/HostProcess";
import * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const ConnectorPath = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.NullOr(Schema.String)),
);

const READ_CONNECTOR = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
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
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const process = yield* spawner.spawn(
    ChildProcess.make(connector, ["--t3-desktop-share-connect"], { shell: false }),
  );
  const context = yield* Layer.build(CodexClient.layerChildProcess(process));
  return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context));
});
