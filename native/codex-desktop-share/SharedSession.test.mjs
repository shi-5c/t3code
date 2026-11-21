import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { SharedSession } from "./SharedSession.mjs";

const threadId = "native-thread";

function peer(history, startTurn) {
  let close;
  let notify;
  let onRequest;
  const calls = [];
  return {
    calls,
    request(method, params) {
      calls.push({ method, params });
      if (method === "thread/resume") return Promise.resolve({ thread: { id: threadId } });
      if (method === "thread/turns/list") return Promise.resolve(history(params.cursor));
      if (method === "turn/start" && startTurn) return startTurn();
      throw new Error(`Unexpected request ${method}.`);
    },
    onClose(listener) {
      close = listener;
    },
    onNotification(listener) {
      notify = listener;
    },
    onRequest(listener) {
      onRequest = listener;
    },
    requestApproval(id, nativeThreadId) {
      onRequest({
        id,
        method: "item/commandExecution/requestApproval",
        params: { threadId: nativeThreadId },
      });
    },
    respond(id, result) {
      calls.push({ method: "respond", id, result });
    },
    completed() {
      notify({ method: "turn/completed", params: { threadId } });
    },
    close() {
      close();
    },
  };
}

NodeTest.test("reconciles native pages and never resends a turn after disconnect", async () => {
  const lostResponse = Promise.withResolvers();
  const delay = Promise.withResolvers();
  const initial = peer(
    () => ({
      data: [{ id: "turn-1", items: [{ id: "item-1" }] }],
      nextCursor: null,
    }),
    () => lostResponse.promise,
  );
  const reconnected = peer((cursor) =>
    cursor === null
      ? {
          data: [{ id: "turn-1", items: [{ id: "item-1" }, { id: "item-1" }] }],
          nextCursor: "next",
        }
      : {
          data: [
            { id: "turn-1", items: [{ id: "item-1" }] },
            { id: "turn-2", items: [{ id: "item-2" }] },
          ],
          nextCursor: null,
        },
  );
  const connections = [initial, reconnected];
  const session = new SharedSession(
    threadId,
    () => Promise.resolve(connections.shift()),
    () => delay.promise,
  );
  try {
    await session.connect();
    const attempted = session.startTurn("response may be lost");
    initial.close();
    lostResponse.reject(new Error("No acknowledgment"));
    await NodeAssert.rejects(attempted, /No acknowledgment/);
    NodeAssert.equal(session.snapshot.online, false);
    NodeAssert.deepEqual(
      session.snapshot.turns.map(({ id }) => id),
      ["turn-1"],
    );
    await NodeAssert.rejects(session.startTurn("offline"), /offline/);

    const available = Promise.withResolvers();
    session.subscribe((view) => {
      if (view.online) available.resolve(view);
    });
    delay.resolve();
    const snapshot = await available.promise;
    NodeAssert.deepEqual(
      snapshot.turns.map(({ id }) => id),
      ["turn-1", "turn-2"],
    );
    NodeAssert.equal(snapshot.turns[0].items.length, 1);
    NodeAssert.deepEqual(
      reconnected.calls.map(({ method }) => method),
      ["thread/resume", "thread/turns/list", "thread/turns/list"],
    );
  } finally {
    session.close();
  }
});

NodeTest.test(
  "does not publish incompletely paginated history when the cursor repeats",
  async () => {
    const bad = peer(() => ({ data: [{ id: "turn-1", items: [] }], nextCursor: "repeated" }));
    const session = new SharedSession(threadId, () => Promise.resolve(bad));
    try {
      await NodeAssert.rejects(session.connect(), /repeated native history cursor/);
      NodeAssert.deepEqual(session.snapshot, { threadId, online: false, turns: [] });
    } finally {
      session.close();
    }
  },
);

NodeTest.test("reads older native threads using their legacy history mode", async () => {
  const legacy = peer(() => {
    throw new Error("Legacy history must not use the paginated endpoint.");
  });
  const calls = [];
  const session = new SharedSession(threadId, () =>
    Promise.resolve({
      ...legacy,
      request(method, params) {
        calls.push({ method, params });
        return Promise.resolve({
          thread: {
            id: threadId,
            historyMode: "legacy",
            turns: [{ id: "existing-turn", items: [{ id: "assistant-item" }] }],
          },
        });
      },
    }),
  );
  try {
    await session.connect();
    NodeAssert.deepEqual(
      calls.map(({ method }) => method),
      ["thread/resume", "thread/read"],
    );
    NodeAssert.equal(calls[1].params.includeTurns, true);
    NodeAssert.equal(session.snapshot.turns[0].items[0].id, "assistant-item");
  } finally {
    session.close();
  }
});

NodeTest.test(
  "does not overwrite a recovered snapshot with history from the closed peer",
  async () => {
    const oldResult = Promise.withResolvers();
    let reads = 0;
    const previous = peer(() =>
      ++reads === 1 ? { data: [], nextCursor: null } : oldResult.promise,
    );
    const current = peer(() => ({ data: [{ id: "current-turn", items: [] }], nextCursor: null }));
    const connections = [previous, current];
    const scheduled = Promise.withResolvers();
    const session = new SharedSession(
      threadId,
      () => Promise.resolve(connections.shift()),
      () => scheduled.promise,
    );
    try {
      await session.connect();
      previous.completed();
      const stale = session.refresh();
      previous.close();
      await session.connect();
      oldResult.resolve({ data: [{ id: "stale-turn", items: [] }], nextCursor: null });
      await stale;
      NodeAssert.deepEqual(
        session.snapshot.turns.map(({ id }) => id),
        ["current-turn"],
      );
    } finally {
      scheduled.resolve();
      session.close();
    }
  },
);

NodeTest.test(
  "rejects an approval handle from the old connection even when the new peer reuses its ID",
  async () => {
    const previous = peer(() => ({ data: [], nextCursor: null }));
    const current = peer(() => ({ data: [], nextCursor: null }));
    const connections = [previous, current];
    const scheduled = Promise.withResolvers();
    const session = new SharedSession(
      threadId,
      () => Promise.resolve(connections.shift()),
      () => scheduled.promise,
    );
    const approvals = [];
    session.onRequest((request) => approvals.push(request));
    try {
      await session.connect();
      previous.requestApproval(1, "unrelated-thread");
      previous.requestApproval(1, threadId);
      NodeAssert.equal(approvals.length, 1);
      previous.close();
      await session.connect();
      current.requestApproval(1, threadId);
      NodeAssert.throws(() => approvals[0].respond({ decision: "accept" }), /closed connection/);
      approvals[1].respond({ decision: "decline" });
      NodeAssert.deepEqual(
        current.calls.filter(({ method }) => method === "respond"),
        [{ method: "respond", id: 1, result: { decision: "decline" } }],
      );
    } finally {
      scheduled.resolve();
      session.close();
    }
  },
);
