const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "prepare-server-compile-cache.cjs"), "utf8");
function fixture(env = {}, platform = "win32") {
  const calls = { spawn: 0, write: 0, cleanup: 0 };
  const sandbox = {
    module: { exports: {} },
    process: { platform, arch: "x64", env },
    console: { log() {} },
    require(name) {
      if (name === "node:child_process")
        return {
          spawnSync() {
            calls.spawn++;
            return { status: 0 };
          },
        };
      if (name === "node:fs")
        return {
          mkdtempSync() {
            return "/synthetic/cache";
          },
          writeFileSync() {
            calls.write++;
          },
          rmSync() {
            calls.cleanup++;
          },
        };
      return require(name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: "prepare-server-compile-cache.cjs" });
  return { calls, hook: sandbox.module.exports };
}
const context = {
  appOutDir: "/synthetic/app",
  electronPlatformName: "win32",
  arch: 1,
  packager: { appInfo: { productFilename: "Test" } },
};
test("explicit opt-out does not spawn or create cache files", async () => {
  const f = fixture({ T3CODE_SKIP_PREPARED_SERVER_CACHE: "1" });
  await f.hook(context);
  assert.deepEqual(f.calls, { spawn: 0, write: 0, cleanup: 0 });
});
test("default native packaging retains prepared cache generation", async () => {
  const f = fixture();
  await f.hook(context);
  assert.deepEqual(f.calls, { spawn: 1, write: 1, cleanup: 1 });
});
test("only explicit 1 opts out", async () => {
  const f = fixture({ T3CODE_SKIP_PREPARED_SERVER_CACHE: "0" });
  await f.hook(context);
  assert.equal(f.calls.spawn, 1);
});
test("cross-platform packaging still skips cache generation", async () => {
  const f = fixture({}, "linux");
  await f.hook(context);
  assert.deepEqual(f.calls, { spawn: 0, write: 0, cleanup: 0 });
});

test("missing prepared cache retains runtime cache fallback", () => {
  let enabled = 0;
  const runtime = fs
    .readFileSync(path.join(__dirname, "../apps/desktop/src/compileCache.ts"), "utf8")
    .replace(/^import .*;\r?\n/gm, "");
  vm.runInNewContext(runtime, {
    process: {
      platform: "win32",
      env: { ELECTRON_RUN_AS_NODE: "1" },
      argv: ["test", "/synthetic/server.cjs"],
    },
    NodeModule: {
      enableCompileCache() {
        enabled++;
      },
    },
    NodeOS: {
      tmpdir() {
        return "/synthetic/tmp";
      },
    },
    NodePath: path,
    enablePreparedServerCache() {
      return false;
    },
  });
  assert.equal(enabled, 1);
});
