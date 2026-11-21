import {
  CODEX_DESKTOP_SHARE_DRIVER,
  CodexDesktopShareSettings,
  isCodexDesktopShareInstance,
} from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { buildCodexInitializeParams } from "../CodexProvider.ts";
import { locateDesktopShareConnector, openDesktopShareClient } from "./CodexDesktopShareRuntime.ts";

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

const preflight = Effect.fn("CodexDesktopShareDriver.preflight")(function* () {
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
  if (hasOverride) {
    const connector = yield* locateDesktopShareConnector();
    if (!connector) return `Codex Desktop ${version} has an existing CODEX_CLI_PATH override.`;
    const connected = yield* Effect.gen(function* () {
      const client = yield* openDesktopShareClient(connector);
      yield* client.request("initialize", buildCodexInitializeParams());
      yield* client.notify("initialized", undefined);
      return true;
    }).pipe(
      Effect.scoped,
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => false),
    );
    return connected
      ? `Codex Desktop ${version} is sharing its app-server. T3 conversation projection is unavailable.`
      : `Codex Desktop ${version} did not accept a T3 connection to the shared app-server.`;
  }
  return `Codex Desktop ${version} has no verified shared-session runtime.`;
});

export const CodexDesktopShareDriver: ProviderDriver<
  typeof CodexDesktopShareSettings.Type,
  ChildProcessSpawner.ChildProcessSpawner
> = {
  driverKind: CODEX_DESKTOP_SHARE_DRIVER,
  metadata: {
    displayName: "Codex Desktop Share",
    hasDefaultInstance: false,
    supportsMultipleInstances: false,
  },
  configSchema: CodexDesktopShareSettings,
  defaultConfig: () => ({}),
  create: Effect.fn("CodexDesktopShareDriver.create")(function* ({ instanceId }) {
    const detail = isCodexDesktopShareInstance(instanceId)
      ? yield* preflight()
      : "The Codex Desktop Share instance ID is invalid.";
    return yield* new ProviderDriverError({
      driver: CODEX_DESKTOP_SHARE_DRIVER,
      instanceId,
      detail,
    });
  }),
};
