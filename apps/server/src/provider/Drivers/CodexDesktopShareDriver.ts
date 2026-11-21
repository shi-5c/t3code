import {
  AcpRegistryOperationError,
  CODEX_DESKTOP_SHARE_DRIVER,
  CodexSettings,
  CodexDesktopShareSettings,
  isCodexDesktopShareInstance,
  TextGenerationError,
} from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
} from "@t3tools/provider-core/server/driver";
import { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import type { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import { ProviderAdapterOpenSessionError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Digest from "effect/crypto/Digest";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ServerConfig } from "../../config.ts";
import { makeCodexAdapterV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { requestAllCodexModels } from "../CodexProvider.ts";
import { readDesktopShareThread } from "../CodexDesktopShareHistory.ts";
import {
  locateDesktopShareConnector,
  openDesktopShareClient,
  openDesktopShareReader,
  runDesktopShareLifecycle,
} from "./CodexDesktopShareRuntime.ts";

const Preflight = Schema.fromJsonString(
  Schema.Struct({
    versions: Schema.Array(Schema.String.check(Schema.isPattern(/^\d{1,6}(\.\d{1,6}){3}$/))),
    hasCli: Schema.Boolean,
    hasOverride: Schema.Boolean,
  }),
);

const WINDOWS_PREFLIGHT = String.raw`
$ErrorActionPreference = 'Stop'
$packages = @(Get-AppxPackage -Name OpenAI.Codex | Where-Object { $_.Name -eq 'OpenAI.Codex' })
$cli = $false
if ($packages.Count -eq 1) {
  $cli = Test-Path -LiteralPath (Join-Path $packages[0].InstallLocation 'app/resources/codex.exe') -PathType Leaf
}
$userEnvironment = Get-Item -LiteralPath 'HKCU:\Environment' -ErrorAction SilentlyContinue
$machineEnvironment = Get-Item -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$override = (Test-Path Env:CODEX_CLI_PATH) -or
  ($null -ne $userEnvironment -and $userEnvironment.GetValueNames() -contains 'CODEX_CLI_PATH') -or
  ($machineEnvironment.GetValueNames() -contains 'CODEX_CLI_PATH')
[pscustomobject]@{
  versions = @($packages | ForEach-Object { $_.Version.ToString() })
  hasCli = $cli
  hasOverride = $override
} | ConvertTo-Json -Compress
`;

export const inspectDesktopShareInstall = Effect.fn("CodexDesktopShareDriver.inspectInstall")(
  function* () {
    const platform = yield* HostProcess.Platform;
    const architecture = yield* HostProcess.Architecture;
    if (platform !== "win32" || architecture !== "x64") {
      return "Codex Desktop Share requires a Windows x64 T3 host.";
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const env = yield* HostProcess.Environment;
    const systemRoot = env.SystemRoot ?? env.WINDIR;
    if (!systemRoot) return "Could not locate Windows PowerShell on the T3 host.";
    const result = yield* spawner
      .string(
        ChildProcess.make(
          `${systemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe`,
          ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PREFLIGHT],
          { stdin: "ignore", stderr: "ignore" },
        ),
      )
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Preflight)),
        Effect.timeout("8 seconds"),
        Effect.result,
      );
    if (result._tag === "Failure") return "Could not inspect Codex Desktop on the T3 host.";
    const { versions, hasCli, hasOverride } = result.success;
    if (versions.length > 1) return "Multiple Codex Desktop installations were detected.";
    const version = versions[0];
    if (!version) return "The Codex Desktop Windows package was not found for the T3 host user.";
    if (!hasCli) return `Codex Desktop ${version} has an unrecognized CLI layout.`;
    return { version, hasOverride };
  },
);

type DriverServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Digest.Digest
  | FileSystem.FileSystem
  | IdAllocatorV2
  | McpProviderSessions
  | Path.Path
  | ProviderHost
  | ServerConfig;

const settings = Schema.decodeSync(CodexSettings)({});
const driver = CODEX_DESKTOP_SHARE_DRIVER;
const presentation = {
  displayName: "Codex Desktop Share",
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
} as const;

export const CodexDesktopShareDriver: ProviderDriver<
  typeof CodexDesktopShareSettings.Type,
  DriverServices
> = {
  driverKind: driver,
  metadata: {
    displayName: presentation.displayName,
    hasDefaultInstance: false,
    supportsMultipleInstances: false,
  },
  configSchema: CodexDesktopShareSettings,
  defaultConfig: () => ({}),
  create: Effect.fn("CodexDesktopShareDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    enabled,
  }) {
    const install = isCodexDesktopShareInstance(instanceId)
      ? yield* inspectDesktopShareInstall()
      : "The Codex Desktop Share instance ID is invalid.";
    const driverError = (detail: string) => new ProviderDriverError({ driver, instanceId, detail });
    if (typeof install === "string") return yield* driverError(install);
    if (!enabled) {
      if (install.hasOverride) {
        const host = yield* runDesktopShareLifecycle("Status").pipe(Effect.option);
        if (
          host._tag === "None" ||
          host.value.status === "Unconfigured" ||
          host.value.status === "Conflict"
        ) {
          return yield* driverError("An existing Codex Desktop CLI override is active.");
        }
      }
      yield* runDesktopShareLifecycle("Preflight").pipe(
        Effect.mapError((cause) =>
          driverError("This installation has no verified shared-session runtime. " + cause.message),
        ),
      );
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: driver,
      instanceId,
    });
    const stamp = withInstanceIdentity({
      driverKind: driver,
      instanceId,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const connect = Effect.fn("CodexDesktopShare.connect")(
      function* (options: Parameters<typeof openDesktopShareClient>[1]) {
        const connector = yield* locateDesktopShareConnector();
        if (!connector)
          return yield* driverError("Open Codex Desktop to restore the shared connection.");
        return yield* openDesktopShareClient(connector, options);
      },
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const connectForRead = Effect.fn("CodexDesktopShare.connectForRead")(
      function* () {
        if (!enabled) return yield* driverError("Enable Codex Desktop Share on the Windows host.");
        return yield* openDesktopShareReader();
      },
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const check = Effect.fn("CodexDesktopShare.checkProvider")(function* () {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const makeSnapshot = (
        models: ReturnType<typeof buildServerProvider>["models"],
        authenticated: boolean,
        unavailableReason?: string,
      ) => ({
        ...stamp(
          buildServerProvider({
            presentation,
            enabled,
            checkedAt,
            models,
            probe: {
              installed: true,
              version: install.version,
              status: unavailableReason ? "error" : "ready",
              auth: { status: authenticated ? "authenticated" : "unknown" },
            },
          }),
        ),
        supportsTextGeneration: false,
        ...(enabled && !unavailableReason
          ? { nativeSessions: { canList: true, canLoad: true, canResume: true } }
          : {}),
        ...(unavailableReason ? { availability: "unavailable" as const, unavailableReason } : {}),
      });
      if (!enabled) return makeSnapshot([], false);
      const data = yield* Effect.gen(function* () {
        const client = yield* connectForRead();
        return yield* Effect.all({
          models: requestAllCodexModels(client),
          account: client.request("account/read", {}),
        });
      }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.option);
      if (data._tag === "None") {
        return makeSnapshot([], false, "Open Codex Desktop to restore the shared connection.");
      }
      if (!data.value.account.account && data.value.account.requiresOpenaiAuth) {
        return makeSnapshot([], false, "Sign in to Codex Desktop to use the shared connection.");
      }
      return makeSnapshot(data.value.models, Boolean(data.value.account.account));
    });
    const snapshot = yield* makeManagedServerProvider({
      getSettings: Effect.succeed(enabled),
      streamSettings: Stream.empty,
      haveSettingsChanged: (previous, next) => previous !== next,
      initialSnapshot: () => check(),
      checkProvider: check(),
      refreshInterval: "15 seconds",
      refreshOnInterval: enabled,
      resolveMaintenance: () =>
        Effect.succeed({ provider: driver, packageName: null, update: null }),
    }).pipe(
      Effect.mapError(() => driverError("Could not check the shared Codex Desktop connection.")),
    );
    const orchestrationAdapter = yield* makeCodexAdapterV2({
      sharedDesktop: driver,
      instanceId,
      settings,
      environment: yield* HostProcess.Environment,
      clientFactory: {
        open: Effect.fn("CodexDesktopShare.openSession")(function* (input) {
          return yield* connect(
            input.acceptServerRequest
              ? { acceptServerRequest: input.acceptServerRequest }
              : undefined,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterOpenSessionError({
                  driver,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
          );
        }),
      },
      models: snapshot.getSnapshot.pipe(Effect.map((value) => value.models)),
      digest: yield* Digest.Digest,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocatorV2,
      serverConfig: yield* ServerConfig,
    });
    const unsupported = (operation: string) => () =>
      Effect.fail(
        new TextGenerationError({
          operation,
          detail: "Codex Desktop Share generates text in its shared conversations.",
        }),
      );
    const sameWorkspace = (left: string, right: string) =>
      normalizeProjectPathForComparison(left) === normalizeProjectPathForComparison(right);
    const listSessions = Effect.fn("CodexDesktopShare.listSessions")(
      function* (input: { readonly cwd: string; readonly cursor?: string }) {
        const client = yield* connectForRead();
        const page = yield* client.request("thread/list", {
          cwd: input.cwd,
          limit: 50,
          sortKey: "updated_at",
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          sourceKinds: ["appServer", "cli", "vscode", "unknown"],
        });
        return {
          sessions: page.data
            .filter((thread) => !thread.ephemeral && sameWorkspace(thread.cwd, input.cwd))
            .map((thread) => ({
              sessionId: thread.id,
              cwd: thread.cwd,
              additionalDirectories: [],
              title: (thread.name || thread.preview).slice(0, 1_024) || null,
              updatedAt: DateTime.formatIso(DateTime.makeUnsafe(thread.updatedAt * 1_000)),
              importedThreadId: null,
            })),
          nextCursor: page.nextCursor ?? null,
          canLoad: true,
          canResume: true,
          canDelete: false,
        };
      },
      (effect) =>
        effect.pipe(
          Effect.scoped,
          Effect.timeout("15 seconds"),
          Effect.mapError(
            () =>
              new AcpRegistryOperationError({
                reason: "session_list_failed",
                message: "Could not list Codex Desktop sessions. Check the shared connection.",
              }),
          ),
        ),
    );
    const verifySession = Effect.fn("CodexDesktopShare.verifySession")(
      function* (input: { readonly cwd: string; readonly sessionId: string }) {
        const client = yield* connectForRead();
        const thread = yield* readDesktopShareThread(client, input.sessionId);
        if (thread.ephemeral || !sameWorkspace(thread.cwd, input.cwd)) {
          return yield* driverError("This session is outside the selected project.");
        }
        return { model: thread.model ?? null };
      },
      (effect) =>
        effect.pipe(
          Effect.scoped,
          Effect.timeout("15 seconds"),
          Effect.mapError(
            () =>
              new AcpRegistryOperationError({
                reason: "session_import_failed",
                message: "Could not read this Codex Desktop session in the selected project.",
              }),
          ),
        ),
    );
    return {
      instanceId,
      driverKind: driver,
      continuationIdentity,
      displayName,
      ...(accentColor ? { accentColor } : {}),
      enabled,
      snapshot,
      orchestrationAdapter,
      nativeSessionDiscovery: { listSessions, verifySession },
      textGeneration: {
        generateBranchName: unsupported("generateBranchName"),
        generateCommitMessage: unsupported("generateCommitMessage"),
        generatePrContent: unsupported("generatePrContent"),
        generateReviewGuide: unsupported("generateReviewGuide"),
        generateThreadTitle: unsupported("generateThreadTitle"),
        generateTranscriptionPostProcessing: unsupported("generateTranscriptionPostProcessing"),
      },
    };
  }),
};
