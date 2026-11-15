import { expect, it } from "vite-plus/test";
import type { CodexDesktopState } from "@t3tools/contracts";
import { desktopWireUpdate } from "./wire.ts";

const state: CodexDesktopState = {
  conversationId: "test",
  status: "ready",
  detail: "Connected",
  epoch: "one",
  revision: 1,
  title: "Shared",
  cwd: "",
  model: "",
  activeTurnId: null,
  pendingRequests: 0,
  truncated: false,
  messages: Array.from({ length: 100 }, (_, i) => ({
    id: `${i}`,
    role: "assistant",
    text: "history ".repeat(1000),
  })),
};
it("sends stable history once and only the changing message while streaming", () => {
  const snapshot = desktopWireUpdate(null, state);
  expect(snapshot.reset).toBe(true);
  expect(snapshot.upsert).toHaveLength(100);
  const next = {
    ...state,
    revision: 2,
    messages: [
      ...state.messages.slice(0, -1),
      { id: "99", role: "assistant" as const, text: "new streamed text" },
    ],
  };
  const delta = desktopWireUpdate(state, next);
  expect(delta.reset).toBe(false);
  expect(delta.order).toBeNull();
  expect(delta.upsert).toEqual([next.messages.at(-1)]);
  expect(JSON.stringify(delta).length).toBeLessThan(1000);
  expect(JSON.stringify(snapshot).length).toBeGreaterThan(800_000);
});
it("resets after a reconnect or revision reset and sends ordering changes explicitly", () => {
  expect(desktopWireUpdate(state, { ...state, epoch: "two" }).reset).toBe(true);
  expect(desktopWireUpdate(state, { ...state, revision: 0 }).reset).toBe(true);
  const delta = desktopWireUpdate(state, { ...state, messages: state.messages.slice(-1) });
  expect(delta.order).toEqual(["99"]);
  expect(delta.upsert).toEqual([]);
});
