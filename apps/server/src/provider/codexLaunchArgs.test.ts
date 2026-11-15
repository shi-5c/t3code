import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  sharedCodexNativeOverrideError,
} from "./codexLaunchArgs.ts";

it("refuses native shared account overrides without exposing values", () => {
  for (const env of [
    { T3CODE_CODEX_LAUNCH_ARGS: "--config model_provider=custom" },
    { OPENAI_API_KEY: "test-private-value" },
    { OPENAI_BASE_URL: "test-private-value" },
  ]) {
    const error = sharedCodexNativeOverrideError("", env);
    NodeAssert.ok(error);
    NodeAssert.ok(!error.includes("test-private-value"));
  }
  NodeAssert.ok(sharedCodexNativeOverrideError("--profile alternate", {}));
  NodeAssert.equal(sharedCodexNativeOverrideError("", { CODEX_HOME: "/desktop-home" }), null);
});

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`),
      ["app-server", "--config", 'model="gpt-6.1-sol"', "--strict-config"],
    );
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
