// @effect-diagnostics nodeBuiltinImport:off - Exercises closing and reopening the native SQLite boundary against one real file.
import { expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { SharedDesktopStore } from "./SharedDesktopStore.ts";
import type { SharedDesktopTurnContext } from "./sharedProjection.ts";
import { desktopRequestRef, desktopResponseKey } from "./requests.ts";

const context = (origin: "t3" | "desktop", id: string): SharedDesktopTurnContext => ({
  runId: `run-${id}`,
  attemptId: `attempt-${id}`,
  nodeId: `node-${id}`,
  providerTurnId: `desktop-provider-turn:pending:${id}`,
  messageId: `message-${id}`,
  clientMessageId: origin === "t3" ? `client-${id}` : "",
  userTurnItemId: `item-${id}`,
  ordinal: 1,
  providerTurnOrdinal: 1,
  startedAtMs: 1000,
  origin,
});

it("keeps concurrent response reservations and unknown outcomes without replay", () => {
  const store = new SharedDesktopStore(":memory:");
  try {
    store.bind({
      threadId: "thread",
      conversationId: "native",
      projectId: "project",
      instanceId: "codex-desktop",
    });
    let changes = 0;
    const unsubscribe = store.subscribe("native", () => changes++);
    const release1 = store.beginResponse("native", "request");
    const release2 = store.beginResponse("native", "request");
    expect(store.reserve("response:request", "thread", { decision: "accept" }).type).toBe("new");
    release2();
    expect(store.isResponseInFlight("request")).toBe(true);
    expect(store.reserve("response:request", "thread", { decision: "accept" }).type).toBe(
      "unknown",
    );
    expect(() => store.reserve("response:request", "thread", { decision: "decline" })).toThrow();
    expect(store.deliveryState("response:request")).toBe("unknown");
    release1();
    expect(store.isResponseInFlight("request")).toBe(false);
    store.acknowledge("response:request", null);
    expect(store.reserve("response:request", "thread", { decision: "accept" }).type).toBe(
      "acknowledged",
    );
    expect(changes).toBeGreaterThan(4);
    unsubscribe();
  } finally {
    store.close();
  }
});

it("coordinates stream-before-ack without allocating a second turn identity", () => {
  const store = new SharedDesktopStore(":memory:");
  try {
    const local = context("t3", "local");
    store.rememberTurn("native", local);
    store.beginSubmission("native", local.attemptId);
    expect(() => store.dismissUncertain("native", local.attemptId)).toThrow("already resolved");
    expect(store.rememberImportedTurn("native", context("desktop", "other"), "owner-turn")).toBe(
      false,
    );
    store.rememberTurn("native", local, "owner-turn");
    expect(
      store.resolveTurnContexts("native", { turns: [{ turnId: "owner-turn" }] }).get("owner-turn")
        ?.runId,
    ).toBe(local.runId);
    expect(store.turnContexts("native")).toHaveLength(1);
  } finally {
    store.close();
  }
});

it("clears a definitely unsent reservation and waits for trusted correlation of an uncertain send", () => {
  const store = new SharedDesktopStore(":memory:");
  try {
    const local = context("t3", "local");
    store.reserve(local.attemptId, "thread", { text: "hello" });
    store.rememberTurn("native", local);
    store.beginSubmission("native", local.attemptId);
    store.finishSubmission(local.attemptId, false);
    expect(store.uncertainSubmissions("native")).toEqual([]);
    expect(store.rememberImportedTurn("native", context("desktop", "one"), "one")).toBe(true);
    store.rememberTurn("native", local);
    store.beginSubmission("native", local.attemptId);
    store.finishSubmission(local.attemptId, true);
    expect(store.rememberImportedTurn("native", context("desktop", "two"), "two")).toBe(false);
    expect(store.rememberImportedTurn("native", context("desktop", "three"), "three")).toBe(false);
    expect(store.uncertainSubmissions("native")).toEqual([
      { attemptId: local.attemptId, candidateId: null },
    ]);
    const resolved = store.resolveTurnContexts("native", {
      turns: [{ turnId: "two", items: [{ type: "userMessage", clientId: local.clientMessageId }] }],
    });
    expect(resolved.get("two")?.runId).toBe(local.runId);
    expect(store.uncertainSubmissions("native")).toEqual([]);
  } finally {
    store.close();
  }
});

it("reserves once, replays acknowledgements and never replays an uncertain mutation", () => {
  const store = new SharedDesktopStore(":memory:");
  try {
    const payload = { text: "hello", expectedTurnId: null };
    expect(store.reserve("one", "thread", payload)).toEqual({ type: "new" });
    expect(store.reserve("one", "thread", payload)).toEqual({ type: "unknown" });
    expect(() => store.reserve("one", "other", payload)).toThrow("different input");
    expect(() => store.reserve("one", "thread", { text: "different" })).toThrow("different input");
    store.acknowledge("one", { turnId: "native-turn" });
    expect(store.reserve("one", "thread", payload)).toEqual({
      type: "acknowledged",
      result: { turnId: "native-turn" },
    });
    expect(() => store.acknowledge("one", { turnId: "another" })).toThrow("already acknowledged");
  } finally {
    store.close();
  }
});

it("keeps exactly one T3 binding for each native conversation", () => {
  const store = new SharedDesktopStore(":memory:");
  try {
    const binding = {
      threadId: "thread",
      conversationId: "native",
      projectId: "project",
      instanceId: "codex-desktop",
    };
    store.bind(binding);
    store.bind(binding);
    expect(store.bindings()).toEqual([binding]);
    expect(() => store.bind({ ...binding, threadId: "other" })).toThrow("different T3 binding");
    expect(() =>
      store.bind({ ...binding, threadId: "other", projectId: "another-project" }),
    ).toThrow("different T3 binding");
    expect(() => store.bind({ ...binding, conversationId: "other" })).toThrow(
      "different T3 binding",
    );
  } finally {
    store.close();
  }
});

it("retains bindings, known acknowledgements and unknown outcomes after closing and reopening the file", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-store-"));
  const filename = NodePath.join(directory, "ledger.sqlite");
  try {
    const first = new SharedDesktopStore(filename);
    try {
      first.bind({
        threadId: "thread",
        conversationId: "native",
        projectId: "project",
        instanceId: "codex-desktop",
      });
      first.reserve("ack", "thread", { text: "acknowledged" });
      first.acknowledge("ack", { turnId: "turn" });
      first.reserve("unknown", "thread", { text: "no response" });
      first.reserve(
        desktopResponseKey(
          "native",
          desktopRequestRef({
            id: 7,
            method: "item/tool/requestUserInput",
            turnId: "turn1",
            epoch: "before",
          }),
        ),
        "thread",
        { response: { answers: { q: ["A"] } } },
      );
      const pending = context("t3", "crash");
      first.rememberTurn("native", pending);
      first.beginSubmission("native", pending.attemptId);
    } finally {
      first.close();
    }
    const reopened = new SharedDesktopStore(filename);
    try {
      expect(reopened.bindings()).toHaveLength(1);
      const ref = { id: 7, method: "item/tool/requestUserInput", turnId: "turn1", epoch: "after" };
      expect(
        reopened.reserve(desktopResponseKey("native", desktopRequestRef(ref)), "thread", {
          response: { answers: { q: ["A"] } },
        }).type,
      ).toBe("unknown");
      expect(
        reopened.reserve(
          desktopResponseKey("native", desktopRequestRef({ ...ref, turnId: "turn2" })),
          "thread",
          { response: { answers: { q: ["A"] } } },
        ).type,
      ).toBe("new");
      expect(
        reopened.reserve(
          desktopResponseKey("native", desktopRequestRef({ ...ref, id: "7" })),
          "thread",
          { response: { answers: { q: ["A"] } } },
        ).type,
      ).toBe("new");
      expect(reopened.reserve("ack", "thread", { text: "acknowledged" })).toEqual({
        type: "acknowledged",
        result: { turnId: "turn" },
      });
      expect(reopened.reserve("unknown", "thread", { text: "no response" })).toEqual({
        type: "unknown",
      });
      expect(reopened.uncertainSubmissions("native")).toEqual([
        { attemptId: "attempt-crash", candidateId: null },
      ]);
      expect(reopened.rememberImportedTurn("native", context("desktop", "later"), "later")).toBe(
        false,
      );
      reopened.dismissUncertain("native", "attempt-crash");
      expect(reopened.rememberImportedTurn("native", context("desktop", "later"), "later")).toBe(
        true,
      );
      expect(reopened.reserve("unknown", "thread", { text: "no response" })).toEqual({
        type: "unknown",
      });
    } finally {
      reopened.close();
    }
  } finally {
    NodeFS.unlinkSync(filename);
    NodeFS.rmdirSync(directory);
  }
});
