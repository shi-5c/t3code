import { expect, it } from "vite-plus/test";
import { desktopInstanceSwitchRefusal } from "./identity.ts";

it("keeps shared sessions bound to their owner while allowing ordinary and same-instance model changes", () => {
  expect(desktopInstanceSwitchRefusal("codex-desktop", "codex")).toContain("independent writer");
  expect(desktopInstanceSwitchRefusal("codex", "codex-desktop")).toContain("independent writer");
  expect(desktopInstanceSwitchRefusal("codex-desktop", "codex-desktop")).toBeNull();
  expect(desktopInstanceSwitchRefusal("codex", "codex-work")).toBeNull();
});
