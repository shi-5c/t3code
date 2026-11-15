// @effect-diagnostics nodeBuiltinImport:off - Exercises the synchronous launcher filesystem boundary.
import * as NodeFS from "node:fs";
import { expect, it, vi } from "vite-plus/test";
import { resolveOfficialNativeCodexLaunch } from "./NativeCodexLaunch.ts";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  realpathSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));
vi.mock("node:crypto", () => ({
  createHash: () => {
    let content = "";
    return {
      update(value: unknown) {
        content = String(value);
        return this;
      },
      digest: () =>
        content === "official-shim"
          ? "c54db6755e710c39703f7c37512f9e35ed41042d8080558d2b84b8d2694323c3"
          : content === "official-launcher"
            ? "e14fc83739c13c1074b12bd1acce4010c893c7f6fbfc1593b4a31d74cabb57af"
            : "unknown",
    };
  },
}));

it.each([
  "official",
  "wrapper",
  "launcher",
  "version",
  "platform-version",
  "alias",
  "linked-root",
  "linked-platform",
  "linked-binary",
  "pnpm",
  "missing-binary",
  "node-options",
  "node-path",
  "mixed-node-options",
  "mixed-node-path",
])("preserves the original launch unless the complete npm chain is verified: %s", (kind) => {
  const root = "C:\\npm\\node_modules\\@openai\\codex";
  vi.mocked(NodeFS.readFileSync).mockImplementation((file) => {
    const name = String(file);
    if (name.endsWith("codex.cmd")) return kind === "wrapper" ? "proxy" : "official-shim";
    if (name.endsWith("codex.js")) return kind === "launcher" ? "modified" : "official-launcher";
    return name === `${root}\\package.json`
      ? JSON.stringify({
          name: "@openai/codex",
          version: kind === "version" ? "0.168.0" : "0.167.1",
          bin: { codex: "bin/codex.js" },
          optionalDependencies: {
            "@openai/codex-win32-x64":
              kind === "alias" ? "other-package" : "npm:@openai/codex@0.167.1-win32-x64",
          },
        })
      : JSON.stringify({
          name: "@openai/codex",
          version: kind === "platform-version" ? "0.167.0-win32-x64" : "0.167.1-win32-x64",
        });
  });
  vi.mocked(NodeFS.realpathSync).mockImplementation((file) =>
    kind === "linked-root" ||
    (kind === "linked-platform" && String(file).endsWith("codex-win32-x64")) ||
    (kind === "linked-binary" && String(file).endsWith("codex.exe"))
      ? "C:\\elsewhere"
      : String(file),
  );
  vi.mocked(NodeFS.existsSync).mockImplementation(
    (file) => kind === "pnpm" && String(file).endsWith(".modules.yaml"),
  );
  vi.mocked(NodeFS.statSync).mockReturnValue({
    isFile: () => kind !== "missing-binary",
  } as ReturnType<typeof NodeFS.statSync>);
  const environment: NodeJS.ProcessEnv = {
    PATH: "original-path",
    CODEX_HOME: "original-home",
    HOME: "original-user",
    HTTPS_PROXY: "original-proxy",
    CODEX_MANAGED_BY_BUN: "1",
  };
  if (kind === "node-options") environment.NODE_OPTIONS = "--require=./hook.cjs";
  if (kind === "node-path") environment.NODE_PATH = "alternate-modules";
  if (kind === "mixed-node-options") environment.node_options = "--require=./hook.cjs";
  if (kind === "mixed-node-path") environment.Node_Path = "alternate-modules";
  const result = resolveOfficialNativeCodexLaunch({
    configured: "",
    resolved: "C:\\npm\\codex.cmd",
    platform: "win32",
    arch: "x64",
    environment,
  });
  if (kind !== "official") expect(result).toBeUndefined();
  else {
    expect(result?.command).toBe(
      `${root}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`,
    );
    expect(result?.environment).toEqual({
      PATH: "original-path",
      CODEX_HOME: "original-home",
      HOME: "original-user",
      HTTPS_PROXY: "original-proxy",
      CODEX_MANAGED_PACKAGE_ROOT: root,
      CODEX_MANAGED_BY_NPM: "1",
    });
    expect(environment.CODEX_MANAGED_BY_BUN).toBe("1");
  }
  expect(
    resolveOfficialNativeCodexLaunch({
      configured: "proxy",
      resolved: "C:\\npm\\codex.cmd",
      platform: "win32",
      arch: "x64",
      environment,
    }),
  ).toBeUndefined();
});
