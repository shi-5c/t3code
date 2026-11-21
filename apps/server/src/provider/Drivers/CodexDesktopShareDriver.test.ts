import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { inspectDesktopShareInstall } from "./CodexDesktopShareDriver.ts";

it.effect.each([
  [{ versions: [], hasCli: false, hasOverride: false }, /package was not found/],
  [{ versions: ["1.0.0.0", "2.0.0.0"], hasCli: false, hasOverride: false }, /Multiple/],
  [{ versions: ["1.0.0.0"], hasCli: false, hasOverride: false }, /unrecognized CLI layout/],
  [
    { versions: ["1.0.0.0"], hasCli: true, hasOverride: true },
    { version: "1.0.0.0", hasOverride: true },
  ],
  [
    { versions: ["1.0.0.0"], hasCli: true, hasOverride: false },
    { version: "1.0.0.0", hasOverride: false },
  ],
] as const)("classifies the Windows installation probe %j", ([probe, expected]) =>
  Effect.gen(function* () {
    const result = yield* inspectDesktopShareInstall();
    if (expected instanceof RegExp) {
      assert.match(String(result), expected);
    } else {
      assert.deepEqual(result, expected);
    }
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
