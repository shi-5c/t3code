import { CODEX_DESKTOP_SHARE_DRIVER, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { CodexDesktopShareDriver } from "./CodexDesktopShareDriver.ts";

const instanceId = ProviderInstanceId.make("codexDesktopShare_test");
const preflight = CodexDesktopShareDriver.create({
  instanceId,
  displayName: undefined,
  enabled: true,
  config: {},
  environment: [],
}).pipe(Effect.flip, Effect.scoped);

it.effect.each([
  [{ versions: [], hasCli: false, hasOverride: false }, "package was not found"],
  [{ versions: ["1.0.0.0", "2.0.0.0"], hasCli: false, hasOverride: false }, "Multiple"],
  [{ versions: ["1.0.0.0"], hasCli: false, hasOverride: false }, "unrecognized CLI layout"],
  [{ versions: ["1.0.0.0"], hasCli: true, hasOverride: true }, "existing CODEX_CLI_PATH override"],
  [{ versions: ["1.0.0.0"], hasCli: true, hasOverride: false }, "shared-session runtime"],
] as const)("keeps the runtime unavailable for probe %j", ([probe, expected]) =>
  Effect.gen(function* () {
    const error = yield* preflight;
    assert.equal(error.driver, CODEX_DESKTOP_SHARE_DRIVER);
    assert.include(error.detail, expected);
  }).pipe(
    Effect.provide(
      Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
        string: () => Effect.succeed(JSON.stringify(probe)),
      }),
    ),
    Effect.provideService(HostProcess.Platform, "win32"),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provideService(HostProcess.Environment, { SystemRoot: "Windows" }),
  ),
);
