// @effect-diagnostics nodeBuiltinImport:off - Synchronous launch resolution verifies the exact npm file chain before the scoped spawn.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

const SHIM_HASH = "c54db6755e710c39703f7c37512f9e35ed41042d8080558d2b84b8d2694323c3";
const LAUNCHER_HASH = "e14fc83739c13c1074b12bd1acce4010c893c7f6fbfc1593b4a31d74cabb57af";
const sha256 = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Exact official npm 0.167.1 Windows launcher only; unknown launchers retain their original process semantics. */
export function resolveOfficialNativeCodexLaunch(input: {
  configured: string;
  resolved: string | undefined;
  platform: string;
  arch: string;
  environment: NodeJS.ProcessEnv;
}) {
  if (
    input.platform !== "win32" ||
    input.arch !== "x64" ||
    !["", "codex", "codex.cmd"].includes(input.configured) ||
    !input.resolved ||
    Object.entries(input.environment).some(
      ([key, value]) => ["NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase()) && value?.trim(),
    ) ||
    NodePath.win32.basename(input.resolved).toLowerCase() !== "codex.cmd"
  )
    return undefined;
  try {
    const shim = input.resolved;
    const root = NodePath.win32.join(
      NodePath.win32.dirname(shim),
      "node_modules",
      "@openai",
      "codex",
    );
    if (
      NodePath.win32.normalize(NodeFS.realpathSync(root)).toLowerCase() !==
      NodePath.win32.normalize(root).toLowerCase()
    )
      return undefined;
    if (
      sha256(shim) !== SHIM_HASH ||
      sha256(NodePath.win32.join(root, "bin", "codex.js")) !== LAUNCHER_HASH
    )
      return undefined;
    const main = record(
      JSON.parse(NodeFS.readFileSync(NodePath.win32.join(root, "package.json"), "utf8")),
    );
    const platformRoot = NodePath.win32.join(root, "node_modules", "@openai", "codex-win32-x64");
    const native = record(
      JSON.parse(NodeFS.readFileSync(NodePath.win32.join(platformRoot, "package.json"), "utf8")),
    );
    if (
      main.name !== "@openai/codex" ||
      main.version !== "0.167.1" ||
      record(main.bin).codex !== "bin/codex.js" ||
      record(main.optionalDependencies)["@openai/codex-win32-x64"] !==
        "npm:@openai/codex@0.167.1-win32-x64" ||
      native.name !== "@openai/codex" ||
      native.version !== "0.167.1-win32-x64"
    )
      return undefined;
    // Other package-manager ownership changes the launcher's environment; keep that launcher intact.
    for (let directory = root; ; directory = NodePath.win32.dirname(directory)) {
      if (
        NodeFS.existsSync(NodePath.win32.join(directory, "node_modules", ".modules.yaml")) ||
        (NodePath.win32.basename(directory) === "packages" &&
          NodeFS.existsSync(NodePath.win32.join(directory, "@openai", "codex.json")))
      )
        return undefined;
      if (directory === NodePath.win32.dirname(directory)) break;
    }
    if (
      /\bbun\//.test(input.environment.npm_config_user_agent ?? "") ||
      input.environment.npm_execpath?.includes("bun") ||
      root.includes(".bun\\install\\global")
    )
      return undefined;
    const command = NodePath.win32.join(
      platformRoot,
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    const helper = NodePath.win32.join(NodePath.win32.dirname(command), "codex-code-mode-host.exe");
    for (const file of [
      shim,
      NodePath.win32.join(root, "package.json"),
      NodePath.win32.join(root, "bin", "codex.js"),
      platformRoot,
      NodePath.win32.join(platformRoot, "package.json"),
      command,
      helper,
    ]) {
      if (
        NodePath.win32.normalize(NodeFS.realpathSync(file)).toLowerCase() !==
        NodePath.win32.normalize(file).toLowerCase()
      )
        return undefined;
    }
    if (
      !NodeFS.statSync(command).isFile() ||
      !NodeFS.statSync(
        NodePath.win32.join(NodePath.win32.dirname(command), "codex-code-mode-host.exe"),
      ).isFile()
    )
      return undefined;
    const environment: NodeJS.ProcessEnv = {
      ...input.environment,
      CODEX_MANAGED_PACKAGE_ROOT: NodeFS.realpathSync(root),
    };
    for (const key of [
      "CODEX_MANAGED_BY_NPM",
      "CODEX_MANAGED_BY_BUN",
      "CODEX_MANAGED_BY_PNPM",
      "CODEX_MANAGED_BY_VITE_PLUS",
    ])
      delete environment[key];
    environment.CODEX_MANAGED_BY_NPM = "1";
    return { command, environment };
  } catch {
    return undefined;
  }
}
