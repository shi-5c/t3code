import { expect, it } from "vite-plus/test";
import type { CodexDesktopUpdate } from "@t3tools/contracts";
import { mergeDesktopUpdate } from "./codexDesktopUpdates.ts";

const update: CodexDesktopUpdate = {
  reset: true,
  metadata: {
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
  },
  upsert: [
    { id: "one", role: "user", text: "question" },
    { id: "two", role: "assistant", text: "answer" },
  ],
  order: ["one", "two"],
};
it("reconciles deltas, deletions and reconnect snapshots without repeating messages", () => {
  const snapshot = mergeDesktopUpdate(null, update);
  const delta = mergeDesktopUpdate(snapshot, {
    ...update,
    reset: false,
    order: null,
    upsert: [{ id: "two", role: "assistant", text: "answer continued" }],
  });
  expect(delta.messages.map((message) => message.text)).toEqual(["question", "answer continued"]);
  expect(delta.messages[0]).toBe(snapshot.messages[0]);
  const deleted = mergeDesktopUpdate(delta, {
    ...update,
    reset: false,
    order: ["two"],
    upsert: [],
  });
  expect(deleted.messages).toHaveLength(1);
  const fresh = mergeDesktopUpdate(deleted, {
    ...update,
    metadata: { ...update.metadata, epoch: "new" },
    upsert: [],
    order: [],
  });
  expect(fresh.messages).toEqual([]);
});
it("rejects missing baselines and retains the message array for metadata-only updates", () => {
  const snapshot = mergeDesktopUpdate(null, update);
  expect(
    mergeDesktopUpdate(snapshot, { ...update, reset: false, order: null, upsert: [] }).messages,
  ).toBe(snapshot.messages);
  expect(() => mergeDesktopUpdate(null, { ...update, reset: false })).toThrow("snapshot");
  expect(() =>
    mergeDesktopUpdate(snapshot, {
      ...update,
      reset: false,
      metadata: { ...update.metadata, epoch: "wrong" },
    }),
  ).toThrow("snapshot");
  expect(() => mergeDesktopUpdate(snapshot, { ...update, order: ["missing"] })).toThrow("missing");
});
