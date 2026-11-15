import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DesktopMirror } from "./DesktopMirror.ts";
import { DesktopIpc, DesktopTransportError } from "./protocol.ts";

const id = "test-conversation";
class FakeDesktop extends DesktopIpc {
  calls: { method: string; params: Record<string, unknown>; version: number }[] = [];
  rejectSend = false;
  snapshotRevision = 4;
  state = {
    id,
    title: "Shared",
    turns: [] as unknown[],
    threadRuntimeStatus: { type: "idle" },
    currentPermissions: {} as Record<string, unknown>,
    requests: [] as unknown[],
  };
  override async connect() {}
  override follow() {}
  override close() {}
  update(change: unknown, owner = "desktop", version = 11) {
    this.emit("broadcast", {
      method: "thread-stream-state-changed",
      sourceClientId: owner,
      version,
      params: { hostId: "local", conversationId: id, change },
    });
  }
  override async request(method: string, params: Record<string, unknown>, version: number) {
    this.calls.push({ method, params, version });
    if (method === "thread-owner-discovery")
      return { handledByClientId: "desktop", result: { supportsUntrustedAppInput: true } };
    if (method === "thread-follower-load-complete-history")
      this.update({
        type: "snapshot",
        revision: this.snapshotRevision,
        conversationState: structuredClone(this.state),
      });
    if (this.rejectSend && method === "thread-follower-start-turn")
      throw new DesktopTransportError("response lost", true);
    if (method === "thread-follower-start-turn")
      return { result: { result: { turn: { id: "started-turn" } } } };
    return { result: {} };
  }
}
let mirror: DesktopMirror;
let desktop: FakeDesktop;
beforeEach(() => {
  vi.useFakeTimers();
  desktop = new FakeDesktop();
  mirror = new DesktopMirror(id, () => desktop);
});
afterEach(() => {
  mirror.close();
  vi.useRealTimers();
});

describe("Desktop owner following", () => {
  it("answers the exact pending native request and rejects stale references without sending", async () => {
    desktop.state.turns = [{ turnId: "active", status: "inProgress", items: [] }];
    desktop.state.threadRuntimeStatus.type = "active";
    desktop.state.requests = [
      { id: 7, method: "item/commandExecution/requestApproval", params: { turnId: "active" } },
    ];
    await mirror.connect();
    const ref = {
      id: 7,
      method: "item/commandExecution/requestApproval",
      turnId: "active",
      epoch: mirror.view.epoch,
    };
    await mirror.respond(ref, { decision: "decline" });
    expect(desktop.calls.at(-1)).toEqual({
      method: "thread-follower-command-approval-decision",
      version: 1,
      params: { conversationId: id, requestId: 7, decision: "decline" },
    });
    const sent = desktop.calls.length;
    await expect(mirror.respond({ ...ref, epoch: "old" }, {})).rejects.toThrow("expired");
    await expect(mirror.respond({ ...ref, id: "7" }, {})).rejects.toThrow("no longer pending");
    await expect(mirror.respond({ ...ref, turnId: "old-turn" }, {})).rejects.toThrow(
      "no longer pending",
    );
    expect(desktop.calls.length).toBe(sent);
  });
  it("inherits the restricted owner's permissions even when a caller supplies full-access defaults", async () => {
    desktop.state.currentPermissions = {
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly" },
    };
    await mirror.connect();
    await mirror.start(
      {
        threadId: id,
        input: [{ type: "text", text: "hello" }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        permissions: ":danger-full-access",
      },
      false,
    );
    const turnStart = desktop.calls.at(-1)?.params.turnStart as {
      request: Record<string, unknown>;
      context: Record<string, unknown>;
    };
    expect(turnStart.context).toEqual({ inheritThreadSettings: true });
    expect(turnStart.request).not.toHaveProperty("approvalPolicy");
    expect(turnStart.request).not.toHaveProperty("sandboxPolicy");
    expect(turnStart.request).not.toHaveProperty("permissions");
  });
  it("routes a start to the existing owner with Desktop-safe input and inherited settings", async () => {
    await mirror.connect();
    expect(mirror.view.status).toBe("ready");
    await mirror.send({
      conversationId: id,
      clientMessageId: "message-1",
      text: "hello",
      expectedTurnId: null,
    });
    expect(desktop.calls.at(-1)).toMatchObject({
      method: "thread-follower-start-turn",
      version: 2,
      params: {
        turnStart: {
          request: { input: [{ type: "text", text: "hello", text_elements: [] }] },
          context: { inheritThreadSettings: true },
        },
      },
    });
    expect(desktop.calls.some((call) => /resume|app-server/.test(call.method))).toBe(false);
  });
  it("applies only owner events, refreshes gaps, and accepts a reset revision on a full snapshot", async () => {
    await mirror.connect();
    desktop.update(
      {
        type: "patches",
        revision: 5,
        patches: [{ op: "replace", path: ["title"], value: "wrong" }],
      },
      "stranger",
    );
    expect(mirror.view.title).toBe("Shared");
    desktop.update({
      type: "patches",
      revision: 5,
      patches: [{ op: "replace", path: ["title"], value: "live" }],
    });
    expect(mirror.view.title).toBe("live");
    desktop.snapshotRevision = 9;
    desktop.update({ type: "patches", revision: 9, patches: [] });
    await Promise.resolve();
    expect(mirror.view.revision).toBe(9);
    const previousEpoch = mirror.view.epoch;
    desktop.update({ type: "snapshot", revision: 1, conversationState: desktop.state });
    expect(mirror.view.revision).toBe(1);
    expect(mirror.view.status).toBe("ready");
    expect(mirror.view.epoch).not.toBe(previousEpoch);
  });
  it("never retries an uncertain send and deduplicates the same message identifier", async () => {
    await mirror.connect();
    desktop.rejectSend = true;
    const input = {
      conversationId: id,
      clientMessageId: "uncertain",
      text: "hello",
      expectedTurnId: null,
    };
    await expect(mirror.send(input)).rejects.toThrow("response lost");
    await expect(mirror.send(input)).rejects.toThrow("response lost");
    expect(
      desktop.calls.filter((call) => call.method === "thread-follower-start-turn"),
    ).toHaveLength(1);
    await expect(mirror.send({ ...input, text: "different" })).rejects.toThrow("identifier");
  });
  it("rejects unguarded legacy steering while retaining native guarded interrupt", async () => {
    desktop.state.turns = [{ turnId: "active", status: "inProgress", items: [] }];
    desktop.state.threadRuntimeStatus.type = "active";
    await mirror.connect();
    await expect(mirror.stop("previous")).rejects.toThrow("active turn changed");
    await expect(
      mirror.send({
        conversationId: id,
        clientMessageId: "steer",
        text: "follow up",
        expectedTurnId: "active",
      }),
    ).rejects.toThrow("cannot atomically target");
    expect(desktop.calls.some((call) => call.method === "thread-follower-steer-turn")).toBe(false);
    await mirror.stop("active");
    expect(desktop.calls.at(-1)?.params.expectedTurnId).toBe("active");
  });
  it("disables sending on protocol drift and does not reconnect in a loop", async () => {
    await mirror.connect();
    desktop.update({ type: "patches", revision: 5, patches: [] }, "desktop", 12);
    expect(mirror.view.status).toBe("incompatible");
    await expect(
      mirror.send({
        conversationId: id,
        clientMessageId: "blocked",
        text: "hi",
        expectedTurnId: null,
      }),
    ).rejects.toThrow("reconnect");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(desktop.calls.filter((call) => call.method === "initialize")).toHaveLength(0);
    expect(mirror.view.status).toBe("incompatible");
  });
});
