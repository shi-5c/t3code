import { desktopResponseKey } from "./requests.ts";
import { OrchestrationV2AppThread, ProviderSessionId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import {
  desktopEventFingerprint,
  sharedDesktopEvents,
  SharedDesktopHistory,
} from "./sharedProjection.ts";
import { sharedProviderEvents } from "./sharedProviderEvents.ts";

const now = DateTime.makeUnsafe(1_000);
const thread = Schema.decodeSync(OrchestrationV2AppThread)({
  id: "codex-desktop:test",
  projectId: "test-project",
  title: "Shared",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "codex-desktop:test" },
  forkedFrom: null,
  createdBy: "system",
  creationSource: "server",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
});

it("reconciles a shared thread's mode with current owner permissions in both directions", () => {
  const base = { nativeId: "test", epoch: "permissions", revision: 1, now };
  const project = (currentThread: typeof thread, approvalPolicy: string, type: string) =>
    sharedDesktopEvents({
      ...base,
      thread: currentThread,
      state: { currentPermissions: { approvalPolicy, sandboxPolicy: { type } }, turns: [] },
    }).flatMap((event) => (event.type === "thread.metadata-updated" ? [event.payload] : []))[0]!;
  const full = project(
    { ...thread, runtimeMode: "approval-required" },
    "never",
    "dangerFullAccess",
  );
  expect(full.runtimeMode).toBe("full-access");
  expect(project(full, "untrusted", "readOnly").runtimeMode).toBe("approval-required");
  expect(project(full, "on-request", "workspaceWrite").runtimeMode).toBe("full-access");
});

it("preserves every file diff and move target across partial updates and reconnects", () => {
  const history = new SharedDesktopHistory();
  const changes = [
    { path: "added.txt", kind: { type: "add" }, diff: "added\n" },
    { path: "binary.bin", kind: { type: "update" } },
    { path: "removed.txt", kind: { type: "delete" }, diff: "removed\n" },
    {
      path: "old.txt",
      kind: { type: "update", move_path: "new.txt" },
      diff: "@@ -1 +1 @@\n-old\n+new\n",
    },
    { path: "future.txt", kind: { type: "future-operation" } },
  ];
  const project = (status: string, entries: unknown[], epoch = "one") =>
    sharedDesktopEvents({
      thread,
      nativeId: "test",
      epoch,
      revision: 1,
      now,
      history,
      state: {
        turns: [
          {
            turnId: "files",
            status: "inProgress",
            items: [{ type: "fileChange", id: "patch", status, changes: entries }],
          },
        ],
      },
    }).flatMap((event) =>
      event.type === "turn-item.updated" && event.payload.type === "file_change"
        ? [event.payload]
        : [],
    );
  const partial = project("inProgress", changes.slice(0, 1));
  const initial = project("inProgress", changes);
  expect(initial[0]?.id).toBe(partial[0]?.id);
  expect(initial).toHaveLength(5);
  expect(initial.every((item) => item.status === "running")).toBe(true);
  const completed = project("completed", changes.toReversed(), "two");
  expect(completed.map((item) => [item.id, item.ordinal])).toEqual(
    initial.map((item) => [item.id, item.ordinal]),
  );
  expect(completed.map((item) => item.diffStr)).toEqual([
    "added\n",
    undefined,
    undefined,
    "@@ -1 +1 @@\n-old\n+new\n",
    "removed\n",
  ]);
  expect(completed.find((item) => item.fileName === "new.txt")).toMatchObject({
    status: "completed",
    nativeItemRef: { nativeId: "patch" },
    changes: [{ operation: "update", path: "new.txt", oldPath: "old.txt" }],
  });
  expect(completed.find((item) => item.fileName === "future.txt")?.changes).toEqual([
    { operation: "future-operation", path: "future.txt" },
  ]);
  const unavailable = completed.find((item) => item.fileName === "future.txt");
  expect(unavailable?.diffStr).toBeUndefined();
  expect(unavailable?.additions).toBeUndefined();
  expect(unavailable?.deletions).toBeUndefined();
  expect(completed.find((item) => item.fileName === "binary.bin")?.diffStr).toBeUndefined();
  const retained = sharedDesktopEvents({
    thread,
    nativeId: "test",
    epoch: "three",
    revision: 0,
    now,
    history,
    state: { turns: [{ turnId: "files", status: "completed", items: [] }] },
  }).flatMap((event) =>
    event.type === "turn-item.updated" && event.payload.type === "file_change"
      ? [event.payload]
      : [],
  );
  expect(retained.map((item) => [item.id, item.status, item.diffStr])).toEqual(
    completed.map((item) => [item.id, item.status, item.diffStr]),
  );
});

it.each([
  ["failed", "completed", "failed"],
  ["declined", "completed", "cancelled"],
  ["inProgress", "interrupted", "interrupted"],
  ["inProgress", "completed", "failed"],
  ["completed", "failed", "completed"],
])("keeps file outcome %s distinct from turn outcome %s", (fileStatus, turnStatus, expected) => {
  const events = sharedDesktopEvents({
    thread,
    nativeId: "test",
    epoch: "one",
    revision: 1,
    now,
    state: {
      turns: [
        {
          turnId: "files",
          status: turnStatus,
          items: [
            {
              type: "fileChange",
              id: "patch",
              status: fileStatus,
              changes: [{ path: "a", kind: { type: "update" } }],
            },
          ],
        },
      ],
    },
  });
  expect(
    events.find(
      (event) => event.type === "turn-item.updated" && event.payload.type === "file_change",
    )?.payload,
  ).toMatchObject({ status: expected });
});

it("supersedes earlier todo versions and forwards the latest plan before the local run terminal", () => {
  const history = new SharedDesktopHistory();
  const first = {
    type: "todo-list",
    id: "todo-one",
    explanation: "Prepare",
    plan: [
      { step: "Edit fixture", status: "in_progress" },
      { step: "Check", status: "pending" },
    ],
  };
  const latest = {
    ...first,
    id: "todo-two",
    explanation: "Done",
    plan: first.plan.map((step) => ({ ...step, status: "completed" })),
  };
  const project = (items: unknown[], status: string, epoch = "one") =>
    sharedDesktopEvents({
      thread,
      nativeId: "test",
      epoch,
      revision: 1,
      now,
      history,
      state: { turns: [{ turnId: "plan-turn", status, items }] },
    });
  const initial = project([first], "inProgress");
  const next = project([latest], "inProgress");
  const plan = next.filter((event) => event.type === "plan.updated");
  expect(plan).toHaveLength(2);
  expect(plan[0]?.payload).toMatchObject({
    id: initial.find((event) => event.type === "plan.updated")?.payload.id,
    status: "superseded",
  });
  expect(plan[1]?.payload).toMatchObject({
    status: "completed",
    kind: "todo_list",
    explanation: "Done",
    steps: [
      { id: "step-1", text: "Edit fixture", status: "completed" },
      { id: "step-2", text: "Check", status: "completed" },
    ],
  });
  expect(plan.filter((event) => event.payload.status === "active")).toHaveLength(0);
  const terminal = project([], "completed", "reconnected");
  expect(
    terminal.filter((event) => event.type === "plan.updated").map((event) => event.payload),
  ).toEqual(plan.map((event) => event.payload));
  const provider = sharedProviderEvents(terminal);
  expect(provider.find((event) => event.type === "plan.updated")).toBeDefined();
  expect(provider.at(-1)?.type).toBe("turn.terminal");
});

it.each(["interrupted", "failed", "completed"])(
  "retains unfinished plans on a %s turn",
  (turnStatus) => {
    const events = sharedDesktopEvents({
      thread,
      nativeId: "test",
      epoch: "one",
      revision: 1,
      now,
      state: {
        turns: [
          {
            turnId: "plan-turn",
            status: turnStatus,
            completedItemIds: { proposal: false },
            items: [
              { type: "plan", id: "proposal", text: "# Partial proposal" },
              {
                type: "todo-list",
                id: "todo",
                plan: [{ step: "Still pending", status: "pending" }],
              },
            ],
          },
        ],
      },
    });
    expect(
      events.filter((event) => event.type === "plan.updated").map((event) => event.payload.status),
    ).toEqual(["draft", "active"]);
    expect(
      events
        .filter((event) => event.type === "turn-item.updated")
        .map((event) => event.payload.status),
    ).toEqual([
      turnStatus === "completed" ? "failed" : turnStatus,
      turnStatus === "completed" ? "failed" : turnStatus,
    ]);
    expect(
      events.find(
        (event) => event.type === "turn-item.updated" && event.payload.type === "proposed_plan",
      )?.payload,
    ).toMatchObject({ markdown: "# Partial proposal", streaming: false });
  },
);

it("finishes a streamed proposal only with native completion and retains that anchor on reconnect", () => {
  const history = new SharedDesktopHistory();
  const project = (
    text: string,
    anchors: Record<string, boolean>,
    status = "inProgress",
    epoch = "one",
  ) =>
    sharedDesktopEvents({
      thread,
      nativeId: "test",
      epoch,
      revision: 1,
      now,
      history,
      state: {
        turns: [
          {
            turnId: "plan-turn",
            status,
            completedItemIds: anchors,
            items: [{ type: "plan", id: "proposal", text }],
          },
        ],
      },
    });
  const first = project("# Pro", { proposal: false });
  expect(first.find((event) => event.type === "turn-item.updated")?.payload).toMatchObject({
    type: "proposed_plan",
    streaming: true,
    status: "running",
  });
  const final = project("# Proposal", { proposal: true });
  expect(final.find((event) => event.type === "plan.updated")?.payload).toMatchObject({
    status: "active",
    markdown: "# Proposal",
  });
  const reconnected = project("# Proposal", {}, "completed", "two");
  expect(reconnected.find((event) => event.type === "turn-item.updated")?.payload).toMatchObject({
    id: first.find((event) => event.type === "turn-item.updated")?.payload.id,
    status: "completed",
    streaming: false,
  });
});

it("projects native compaction facts without accepting Desktop's optimistic placeholder", () => {
  const history = new SharedDesktopHistory();
  const project = (turnStatus: string, items: unknown[], epoch = "one") =>
    sharedDesktopEvents({
      thread,
      nativeId: "test",
      epoch,
      revision: 1,
      now,
      history,
      state: { turns: [{ turnId: "compact-turn", status: turnStatus, items }] },
    }).flatMap((e) =>
      e.type === "turn-item.updated" && e.payload.type === "compaction" ? [e.payload] : [],
    );
  const placeholder = {
    type: "contextCompaction",
    id: "pending-manual-context-compaction",
    completed: false,
  };
  expect(project("inProgress", [placeholder])).toEqual([]);
  const native = {
    type: "contextCompaction",
    id: "native-compact",
    completed: false,
    startedAtMs: 900,
  };
  const running = project("inProgress", [native]);
  expect(running).toHaveLength(1);
  expect(running[0]).toMatchObject({
    type: "compaction",
    status: "running",
    title: "Compacting context",
    nativeItemRef: { nativeId: "native-compact" },
    completedAt: null,
  });
  const done = project("inProgress", [{ ...native, completed: true, completedAtMs: 950 }]);
  expect(done[0]).toMatchObject({ status: "completed", title: "Context compacted" });
  expect(
    project("completed", [{ ...native, completed: true, completedAtMs: 950 }], "reconnected")[0]
      ?.id,
  ).toBe(done[0]?.id);
});

it.each(["failed", "interrupted", "cancelled", "completed"])(
  "does not infer compaction success from terminal turn %s",
  (turnStatus) => {
    const facts = sharedDesktopEvents({
      thread,
      nativeId: "test",
      epoch: "one",
      revision: 1,
      now,
      state: {
        turns: [
          {
            turnId: "compact-turn",
            status: turnStatus,
            items: [{ type: "contextCompaction", id: "native-compact", completed: false }],
          },
        ],
      },
    });
    const item = facts.find(
      (e) => e.type === "turn-item.updated" && e.payload.type === "compaction",
    );
    expect(item?.payload).toMatchObject({
      status: turnStatus === "completed" ? "failed" : turnStatus,
    });
  },
);

it("uses owner answers rather than a losing client's optimistic answer and expires old connection cards", () => {
  const history = new SharedDesktopHistory();
  const request = {
    id: 7,
    method: "item/tool/requestUserInput",
    params: {
      turnId: "live",
      questions: [
        { id: "q", header: "Pick", question: "Choose?", options: [{ label: "A" }, { label: "B" }] },
      ],
    },
  };
  const initial = { thread, nativeId: "test", epoch: "one", revision: 1, now, history };
  const state = {
    turns: [{ turnId: "live", status: "inProgress", items: [] }],
    requests: [request],
  };
  const first = sharedDesktopEvents({ ...initial, state });
  const provider = first.find((e) => e.type === "provider-thread.updated");
  if (provider?.type !== "provider-thread.updated") throw new Error("Missing provider thread");
  const providerThread = {
    ...provider.payload,
    providerSessionId: ProviderSessionId.make("desktop-session:test"),
  };
  const live = sharedDesktopEvents({ ...initial, state, providerThread });
  const pending = live.find((e) => e.type === "runtime-request.updated");
  if (pending?.type !== "runtime-request.updated") throw new Error("Missing request");
  expect(pending.payload).toMatchObject({
    status: "pending",
    responseCapability: { type: "live", supportsFeedback: false },
  });
  const saved = { ...pending.payload, status: "resolved" as const, answers: { q: "B" } };
  const closed = sharedDesktopEvents({
    ...initial,
    providerThread,
    runtimeRequests: [saved],
    revision: 2,
    state: {
      requests: [],
      turns: [
        {
          turnId: "live",
          status: "inProgress",
          items: [
            {
              type: "userInputResponse",
              id: "user-input-response-7",
              requestId: 7,
              turnId: "live",
              completed: true,
              answers: { q: ["A"] },
            },
          ],
        },
      ],
    },
  });
  expect(closed.find((e) => e.type === "runtime-request.updated")?.payload).toMatchObject({
    status: "resolved",
    answers: { q: ["A"] },
  });
  expect(
    closed.find((e) => e.type === "turn-item.updated" && e.payload.type === "user_input_request")
      ?.payload,
  ).toMatchObject({ questionAnswer: { answers: { q: ["A"] } } });
  const reconnect = sharedDesktopEvents({
    ...initial,
    epoch: "two",
    revision: 3,
    state,
    providerThread,
  });
  const requests = reconnect.filter((e) => e.type === "runtime-request.updated");
  expect(requests.map((e) => e.payload.status)).toEqual(["expired", "pending"]);
  const unknown = sharedDesktopEvents({
    ...initial,
    epoch: "two",
    revision: 3,
    state,
    providerThread,
    reservedResponseKeys: new Set(
      requests.map((e) => desktopResponseKey("test", e.payload.nativeRequestRef!.nativeId!)),
    ),
  });
  expect(
    unknown
      .filter((e) => e.type === "runtime-request.updated")
      .every((e) => e.payload.responseCapability.type === "not_resumable"),
  ).toBe(true);
});

it("shows every requested permission target and the explicit approval duration", () => {
  const permissions = {
    fileSystem: { read: ["C:/input/a", "D:/input/b"], write: ["C:/output"] },
    network: { allowedDomains: ["api.example.test", "cdn.example.test"] },
  };
  const facts = sharedDesktopEvents({
    thread,
    nativeId: "test",
    epoch: "epoch",
    revision: 1,
    now,
    state: {
      turns: [{ turnId: "live", status: "inProgress", items: [] }],
      requests: [
        {
          id: 8,
          method: "item/permissions/requestApproval",
          params: { turnId: "live", reason: "Inspect fixture", permissions },
        },
      ],
    },
  });
  const card = facts.find(
    (e) => e.type === "turn-item.updated" && e.payload.type === "approval_request",
  );
  if (card?.type !== "turn-item.updated" || card.payload.type !== "approval_request")
    throw new Error("Missing approval card");
  expect(card.payload.prompt).toContain(JSON.stringify(permissions, null, 2));
  expect(card.payload.options).toContainEqual({ decision: "accept", label: "Allow for this turn" });
  expect(card.payload.options).toContainEqual({
    decision: "acceptForSession",
    label: "Allow for this session",
  });
});

it("keeps file-change approval read-only even when a live response session exists", () => {
  const input = {
    thread,
    nativeId: "test",
    epoch: "epoch",
    revision: 1,
    now,
    state: {
      turns: [{ turnId: "live", status: "inProgress", items: [] }],
      requests: [
        {
          id: 9,
          method: "item/fileChange/requestApproval",
          params: { turnId: "live", itemId: "edit" },
        },
      ],
    },
  };
  const provider = sharedDesktopEvents(input).find((e) => e.type === "provider-thread.updated");
  if (provider?.type !== "provider-thread.updated") throw new Error("Missing provider thread");
  const facts = sharedDesktopEvents({
    ...input,
    providerThread: {
      ...provider.payload,
      providerSessionId: ProviderSessionId.make("desktop-session:test"),
    },
  });
  expect(facts.find((e) => e.type === "runtime-request.updated")?.payload).toMatchObject({
    kind: "file-change",
    status: "pending",
    responseCapability: { type: "not_resumable", reason: "Answer this request in Codex Desktop." },
  });
});

it("publishes the completed assistant before the terminal event that settles the ordinary T3 run", () => {
  const facts = sharedDesktopEvents({
    thread,
    nativeId: "test",
    epoch: "epoch",
    revision: 1,
    now,
    state: {
      turns: [
        {
          turnId: "done",
          status: "completed",
          params: { input: [{ type: "text", text: "hello" }] },
          items: [{ id: "reply", type: "agentMessage", text: "finished" }],
        },
      ],
    },
  });
  const events = sharedProviderEvents(facts);
  expect(events.at(-1)).toMatchObject({
    type: "turn.terminal",
    status: "completed",
    failure: null,
    runOrdinal: 1,
    providerTurnId: "desktop-provider-turn:done",
  });
  expect(
    events.findIndex(
      (event) => event.type === "message.updated" && event.message.role === "assistant",
    ),
  ).toBeLessThan(events.length - 1);
  expect(events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
});

it("does not terminalize a native turn that is still in progress", () => {
  const facts = sharedDesktopEvents({
    thread,
    nativeId: "test",
    epoch: "epoch",
    revision: 1,
    now,
    state: { turns: [{ turnId: "live", status: "inProgress", items: [] }] },
  });
  expect(sharedProviderEvents(facts).some((event) => event.type === "turn.terminal")).toBe(false);
});

it("projects canonical island order into the existing T3 thread, run, message and timeline schemas", () => {
  const events = sharedDesktopEvents({
    thread,
    nativeId: "test",
    epoch: "epoch",
    revision: 1,
    now,
    state: {
      title: "Desktop",
      threadRuntimeStatus: { type: "active" },
      turnHistory: {
        history: {
          entitiesByKey: {
            second: {
              turnId: "turn-two",
              turnStartedAtMs: 2000,
              status: "inProgress",
              params: { clientUserMessageId: "user-two", input: [{ type: "text", text: "next" }] },
              items: [{ id: "assistant-two", type: "agentMessage", text: "working" }],
            },
            first: {
              turnId: "turn-one",
              turnStartedAtMs: 1000,
              durationMs: 500,
              status: "completed",
              items: [
                { id: "user-one", type: "userMessage", content: [{ type: "text", text: "hello" }] },
                {
                  id: "steer-one",
                  type: "steeringUserMessage",
                  status: "accepted",
                  input: [{ type: "text", text: "桌面跟进\n", text_elements: [] }],
                },
                { id: "assistant-one", type: "agentMessage", text: "done" },
              ],
            },
          },
          isComplete: true,
          islands: [{ entries: [{ key: "first" }, { key: "second" }, { key: "first" }] }],
        },
      },
    },
  });
  const runs = events.filter((e) => e.type === "run.updated").map((e) => e.payload);
  expect(runs.map((run) => [run.id, run.ordinal, run.status])).toEqual([
    ["desktop-run:turn-one", 1, "completed"],
    ["desktop-run:turn-two", 2, "running"],
  ]);
  expect(
    events
      .filter((e) => e.type === "message.updated")
      .map((e) => [e.payload.role, e.payload.text, e.payload.streaming]),
  ).toEqual([
    ["user", "hello", false],
    ["user", "桌面跟进\n", false],
    ["assistant", "done", false],
    ["user", "next", false],
    ["assistant", "working", true],
  ]);
  expect(
    events.filter((e) => e.type === "turn-item.updated").map((e) => e.payload.ordinal),
  ).toEqual([0, 1, 2, 3, 4]);
  expect(
    events.find(
      (event) =>
        event.type === "turn-item.updated" && event.payload.id === "desktop-item:test:steer-one",
    )?.payload,
  ).toMatchObject({ type: "user_message", inputIntent: "steer", text: "桌面跟进\n" });
});

it("keeps one primary input when optimistic and canonical message IDs differ, including reconnect", () => {
  const history = new SharedDesktopHistory();
  const base = { thread, nativeId: "test", epoch: "one", revision: 1, now, history };
  const first = {
    turnId: "turn",
    status: "inProgress",
    params: { clientUserMessageId: "optimistic", input: [{ text: "hello" }] },
    items: [],
  };
  const one = sharedDesktopEvents({ ...base, state: { turns: [first] } });
  const canonical = {
    ...first,
    items: [{ id: "canonical", type: "userMessage", content: [{ text: "hello" }] }],
  };
  const two = sharedDesktopEvents({ ...base, revision: 2, state: { turns: [canonical] } });
  const three = sharedDesktopEvents({
    ...base,
    epoch: "two",
    revision: 0,
    state: { turns: [{ ...canonical, items: [{ ...canonical.items[0], id: "reloaded" }] }] },
  });
  const primary = (events: typeof one) =>
    events.flatMap((e) =>
      e.type === "message.updated" && e.payload.role === "user" ? [e.payload.id] : [],
    );
  expect([one, two, three].map(primary)).toEqual([
    ["desktop-message:test:turn:input"],
    ["desktop-message:test:turn:input"],
    ["desktop-message:test:turn:input"],
  ]);
});

it("waits for a complete baseline and retains earlier turns when later snapshots show a shorter window", () => {
  const history = new SharedDesktopHistory();
  const a = { turnId: "a", status: "completed", items: [] };
  const b = { ...a, turnId: "b" };
  const c = { ...a, turnId: "c" };
  const project = (turns: unknown[], complete: boolean) =>
    sharedDesktopEvents({
      thread,
      nativeId: "test",
      epoch: "test",
      revision: 1,
      now,
      history,
      state: { turnHistory: { history: { isComplete: complete } }, turns },
    });
  expect(project([b, c], false).filter((e) => e.type === "run.updated")).toHaveLength(0);
  const full = project([a, b, c], true)
    .filter((e) => e.type === "run.updated")
    .map((e) => [e.payload.id, e.payload.ordinal]);
  expect(full).toEqual([
    ["desktop-run:a", 1],
    ["desktop-run:b", 2],
    ["desktop-run:c", 3],
  ]);
  expect(
    project([c], false)
      .filter((e) => e.type === "run.updated")
      .map((e) => [e.payload.id, e.payload.ordinal]),
  ).toEqual(full);
});

it("preserves historical model evidence and never infers success from idle or unknown statuses", () => {
  const configuredThread = {
    ...thread,
    modelSelection: {
      ...thread.modelSelection,
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ],
    },
  };
  const base = { thread: configuredThread, nativeId: "test", epoch: "test", revision: 1, now };
  expect(
    sharedDesktopEvents({
      ...base,
      state: {
        latestReasoningEffort: null,
        latestThreadSettings: { serviceTier: null },
        turns: [],
      },
    })
      .flatMap((e) => (e.type === "thread.metadata-updated" ? [e.payload.modelSelection] : []))
      .at(0)?.options,
  ).toEqual([]);
  expect(
    sharedDesktopEvents({
      ...base,
      state: { latestThreadSettings: { serviceTier: "default" }, turns: [] },
    })
      .flatMap((e) => (e.type === "thread.metadata-updated" ? [e.payload.modelSelection] : []))
      .at(0)?.options,
  ).toEqual([
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "default" },
  ]);
  for (const [settings, legacy, expected] of [
    [{ effort: "xhigh" }, null, [{ id: "reasoningEffort", value: "xhigh" }]],
    [{ effort: null }, "high", []],
    [{}, "high", [{ id: "reasoningEffort", value: "high" }]],
    [{ effort: "medium" }, "high", [{ id: "reasoningEffort", value: "medium" }]],
  ] as const) {
    expect(
      sharedDesktopEvents({
        ...base,
        state: {
          latestReasoningEffort: legacy,
          latestThreadSettings: { ...settings, serviceTier: null },
          turns: [],
        },
      })
        .flatMap((e) => (e.type === "thread.metadata-updated" ? [e.payload.modelSelection] : []))
        .at(0)?.options,
    ).toEqual(expected);
  }
  const state = {
    latestModel: "new-model",
    latestReasoningEffort: "medium",
    threadRuntimeStatus: { type: "idle" },
    turns: [{ turnId: "turn", status: "inProgress", params: { model: "old-model" }, items: [] }],
  };
  const events = sharedDesktopEvents({ ...base, state });
  expect(
    sharedDesktopEvents({ ...base, state: { ...state, latestReasoningEffort: undefined } })
      .flatMap((e) => (e.type === "thread.metadata-updated" ? [e.payload.modelSelection] : []))
      .at(0),
  ).toEqual({ instanceId: configuredThread.modelSelection.instanceId, model: "new-model" });
  expect(
    events
      .flatMap((e) => (e.type === "thread.metadata-updated" ? [e.payload.modelSelection] : []))
      .at(0),
  ).toEqual({
    ...configuredThread.modelSelection,
    model: "new-model",
    options: [{ id: "reasoningEffort", value: "medium" }],
  });
  expect(
    sharedDesktopEvents({ ...base, state, syncModelSelection: false })
      .flatMap((e) => (e.type === "thread.metadata-updated" ? [e.payload.modelSelection] : []))
      .at(0),
  ).toEqual(configuredThread.modelSelection);
  expect(events.find((e) => e.type === "run.updated")?.payload).toMatchObject({
    status: "running",
    modelSelection: { model: "old-model" },
  });
  expect(events.find((e) => e.type === "provider-turn.updated")?.payload).toMatchObject({
    status: "running",
    model: "old-model",
  });
  expect(() =>
    sharedDesktopEvents({
      ...base,
      state: { turns: [{ turnId: "turn", status: "future-status", items: [] }] },
    }),
  ).toThrow("No terminal state");
  expect(
    sharedDesktopEvents({
      ...base,
      state: { turns: [{ turnId: "turn", status: "error", items: [] }] },
    }).find((e) => e.type === "run.updated")?.payload,
  ).toMatchObject({ status: "failed" });
});

it("keeps canonical input before an assistant that arrived before the user item", () => {
  const history = new SharedDesktopHistory();
  const base = { thread, nativeId: "test", epoch: "one", revision: 1, now, history };
  const assistant = { id: "assistant", type: "agentMessage", text: "reply" };
  const turn = {
    turnId: "turn",
    status: "inProgress",
    params: { model: "old-model", input: [{ text: "hello" }] },
    items: [assistant],
  };
  const one = sharedDesktopEvents({ ...base, state: { turns: [turn] } });
  const two = sharedDesktopEvents({
    ...base,
    revision: 2,
    state: {
      turns: [
        {
          ...turn,
          params: { input: [{ text: "hello" }] },
          items: [{ id: "user", type: "userMessage", content: [{ text: "hello" }] }, assistant],
        },
      ],
    },
  });
  const positions = (events: typeof one) =>
    events.flatMap((e) =>
      e.type === "turn-item.updated" &&
      (e.payload.type === "user_message" || e.payload.type === "assistant_message")
        ? [[e.payload.id, e.payload.ordinal]]
        : [],
    );
  expect(positions(two)).toEqual(positions(one));
  expect(two.find((e) => e.type === "run.updated")?.payload).toMatchObject({
    modelSelection: { model: "old-model" },
  });
});

it("does not turn an unchanged payload into a new persisted fact on each publication", () => {
  const input = {
    thread,
    nativeId: "test",
    epoch: "epoch",
    revision: 1,
    now,
    state: { turns: [] },
  };
  const first = sharedDesktopEvents(input);
  const next = sharedDesktopEvents({ ...input, revision: 2, now: DateTime.makeUnsafe(2000) });
  expect(first.map(desktopEventFingerprint)).toEqual(next.map(desktopEventFingerprint));
});

it("preserves app-tool input as an attributed notification instead of an empty human message", () => {
  const output = "<codex_delegation><input>reverse input body</input></codex_delegation>";
  const events = sharedDesktopEvents({
    thread,
    nativeId: "test",
    epoch: "epoch",
    revision: 1,
    now,
    state: {
      turns: [
        {
          turnId: "delegated",
          status: "completed",
          params: {
            input: [],
            turnTrigger: "app_tool_send_message",
            toolOutput: { namespace: "codex_app", name: "send_message_to_thread", output },
          },
          items: [
            { id: "tool-output", type: "functionCallOutput", output },
            { id: "reply", type: "agentMessage", text: "reply" },
          ],
        },
      ],
    },
  });
  const input = events.flatMap((event) =>
    event.type === "message.updated" && event.payload.id.endsWith(":input") ? [event.payload] : [],
  );
  expect(input).toHaveLength(1);
  expect(input[0]).toMatchObject({
    role: "system",
    createdBy: "agent",
    text: output,
    notification: { detail: output },
  });
  expect(
    events.some(
      (event) => event.type === "turn-item.updated" && event.payload.type === "user_message",
    ),
  ).toBe(false);
  expect(
    events.flatMap((event) =>
      event.type === "turn-item.updated" && event.payload.type === "notification"
        ? [event.payload.detail]
        : [],
    ),
  ).toEqual([output]);
});

it("does not turn an ordinary function result into user input", () => {
  const events = sharedDesktopEvents({
    thread,
    nativeId: "test",
    epoch: "epoch",
    revision: 1,
    now,
    state: {
      turns: [
        {
          turnId: "tool",
          status: "completed",
          params: {
            input: [],
            toolOutput: {
              name: "shell_command",
              namespace: "functions",
              output: "ordinary tool result",
            },
          },
          items: [
            { id: "result", type: "functionCallOutput", output: "ordinary tool result" },
            { id: "reply", type: "agentMessage", text: "done" },
          ],
        },
      ],
    },
  });
  expect(
    events.some((event) => event.type === "message.updated" && event.payload.role === "user"),
  ).toBe(false);
  expect(
    events.some(
      (event) => event.type === "message.updated" && event.payload.text === "ordinary tool result",
    ),
  ).toBe(false);
});
