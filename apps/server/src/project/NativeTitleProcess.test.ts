import { describe, expect, it } from "vite-plus/test";
import { nativeTitleProcessHasExited, supportsNativeTitleProcess } from "./NativeTitleProcess.ts";

describe("native title process lifetime", () => {
  it("accepts only a direct absolute native executable with its standard app-server argument", () => {
    const direct = {
      configured: "C:/Codex/codex.exe",
      command: "C:/Codex/codex.exe",
      args: ["app-server"],
      shell: false,
    };
    expect(supportsNativeTitleProcess(direct)).toBe(true);
    expect(supportsNativeTitleProcess({ ...direct, command: "proxy.exe" })).toBe(false);
    expect(
      supportsNativeTitleProcess({ ...direct, configured: "proxy.exe", command: "proxy.exe" }),
    ).toBe(false);
    expect(supportsNativeTitleProcess({ ...direct, shell: true })).toBe(false);
    expect(
      supportsNativeTitleProcess({
        ...direct,
        args: ["app-server", "--listen", "ws://127.0.0.1:1"],
      }),
    ).toBe(false);
    expect(supportsNativeTitleProcess({ ...direct, configured: "codex" })).toBe(false);
  });
  it("requires PID absence on the same host and keeps live, reused or inaccessible PIDs unknown", () => {
    const previous = { pid: 321, hostKey: "host-a" };
    const absent = () => {
      throw Object.assign(new Error("absent"), { code: "ESRCH" });
    };
    expect(nativeTitleProcessHasExited("host-a", previous, absent)).toBe(true);
    expect(nativeTitleProcessHasExited("host-b", previous, absent)).toBe(false);
    expect(nativeTitleProcessHasExited(undefined, previous, absent)).toBe(false);
    expect(nativeTitleProcessHasExited("host-a", { ...previous, pid: -1 }, absent)).toBe(false);
    expect(nativeTitleProcessHasExited("host-a", previous, () => {})).toBe(false);
    expect(
      nativeTitleProcessHasExited("host-a", previous, () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }),
    ).toBe(false);
  });
});
