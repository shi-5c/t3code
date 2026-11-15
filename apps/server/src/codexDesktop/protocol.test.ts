import { describe, expect, it } from "vite-plus/test";
import { applyDesktopPatches, desktopTextInput, DesktopIpc, FrameDecoder } from "./protocol.ts";

class RecordingDesktopIpc extends DesktopIpc {
  readonly outgoing: Record<string, unknown>[] = [];
  protected override write(message: Record<string, unknown>) {
    this.outgoing.push(message);
  }
  accept(message: Record<string, unknown>) {
    this.receive(message);
  }
}

const frame = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};

describe("Codex Desktop transport", () => {
  it("keeps a forwarded mutation uncertain when the owner reports an error", async () => {
    const client = new RecordingDesktopIpc();
    try {
      const result = client.request("thread-follower-start-turn", {}, 2, "owner", true);
      const rejected = expect(result).rejects.toMatchObject({ outcomeUnknown: true });
      client.accept({
        type: "response",
        requestId: client.outgoing.at(-1)?.requestId,
        resultType: "error",
        error: "owner lost execution acknowledgement",
      });
      await rejected;
    } finally {
      client.close();
    }
  });
  it("treats a socket write failure as uncertain only for mutations", async () => {
    class FailedWriter extends DesktopIpc {
      protected override write() {
        throw new Error("socket write failed");
      }
    }
    const client = new FailedWriter();
    try {
      await expect(client.request("read", {}, 1)).rejects.toMatchObject({ outcomeUnknown: false });
      await expect(client.request("write", {}, 1, "owner", true)).rejects.toMatchObject({
        outcomeUnknown: true,
      });
    } finally {
      client.close();
    }
  });
  it("rejects requests it cannot handle so other IPC clients do not wait for a timeout", () => {
    const client = new RecordingDesktopIpc();
    client.accept({
      type: "request",
      requestId: "outside-request",
      method: "outside-method",
      version: 1,
    });
    expect(client.outgoing).toEqual([
      {
        type: "response",
        requestId: "outside-request",
        resultType: "error",
        error: "no-handler-for-request",
      },
    ]);
  });
  it("only delivers broadcasts addressed to this client or to all clients", () => {
    const client = new RecordingDesktopIpc();
    const broadcasts: unknown[] = [];
    client.on("broadcast", (message) => broadcasts.push(message));
    client.accept({
      type: "broadcast",
      method: "private-state",
      targetClientIds: ["another-client"],
    });
    client.accept({ type: "broadcast", method: "shared-state" });
    client.accept({
      type: "broadcast",
      method: "own-state",
      targetClientIds: ["initializing-client"],
    });
    expect(broadcasts).toEqual([
      { type: "broadcast", method: "shared-state" },
      { type: "broadcast", method: "own-state", targetClientIds: ["initializing-client"] },
    ]);
  });
  it("decodes fragmented headers and multiple frames without losing boundaries", () => {
    const bytes = Buffer.concat([
      frame({ type: "first" }),
      frame({ type: "second", text: "双向" }),
    ]);
    const decoder = new FrameDecoder();
    const received: unknown[] = [];
    for (const byte of bytes) decoder.push(Buffer.from([byte]), (value) => received.push(value));
    expect(received).toEqual([{ type: "first" }, { type: "second", text: "双向" }]);
  });
  it("rejects oversized frames before buffering their payload", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(64 * 1024 * 1024 + 1);
    expect(() => new FrameDecoder().push(header, () => {})).toThrow("frame size");
  });
  it("always includes the text_elements array needed by the Desktop renderer", () => {
    expect(desktopTextInput("hello")).toEqual([{ type: "text", text: "hello", text_elements: [] }]);
    expect(() => desktopTextInput(" ")).toThrow();
    expect(() => desktopTextInput("a".repeat(64_001))).toThrow();
  });
  it("applies array insert/remove with canonical order and leaves the previous view untouched", () => {
    const state = { items: [{ text: "one" }, { text: "three" }] };
    const next = applyDesktopPatches(state, [
      { op: "add", path: ["items", 1], value: { text: "two" } },
      { op: "replace", path: ["items", 2, "text"], value: "THREE" },
      { op: "remove", path: ["items", 0] },
    ]);
    expect(next).toEqual({ items: [{ text: "two" }, { text: "THREE" }] });
    expect(state.items[0]?.text).toBe("one");
  });
  it("rejects prototype traversal, invalid indexes and partial patch batches", () => {
    const state = { items: [1] };
    for (const path of [
      ["__proto__", "polluted"],
      ["constructor", "prototype"],
      ["items", 12],
      ["missing", "x"],
    ]) {
      expect(() => applyDesktopPatches(state, [{ op: "replace", path, value: true }])).toThrow();
    }
    expect(() =>
      applyDesktopPatches(state, [
        { op: "replace", path: ["items", 0], value: 2 },
        { op: "remove", path: ["missing"] },
      ]),
    ).toThrow();
    expect(state).toEqual({ items: [1] });
  });
});
