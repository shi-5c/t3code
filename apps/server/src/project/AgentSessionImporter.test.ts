import { expect, it } from "@effect/vitest";
import {
  type AgentSessionSource,
  type ServerSettingsError,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  RunId,
  MessageId,
  NodeId,
  ProviderTurnId,
  TurnItemId,
  type ApplicationStoredEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectionReplay from "../orchestration-v2/testkit/ProjectionReplay.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as CodexSessionHistory from "./CodexSessionHistory.ts";
import * as ProjectService from "./ProjectService.ts";
import { refreshSharedNativeHistory } from "./NativeSharedHistory.ts";

const projectId = ProjectId.make("agent-session-import-project");
const timestamp = "2026-09-01T10:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProjectionReplay.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
);

function candidate(
  modelSelection: typeof CODEX_MODEL_SELECTION,
  providerSessionId: string,
  provider: AgentSessionSource = "codex",
) {
  const providerInstanceId = modelSelection.instanceId;
  return {
    _tag: "Importable" as const,
    source: {
      provider,
      providerInstanceId,
      providerSessionId,
      filePath: `/tmp/${providerInstanceId}/${providerSessionId}.jsonl`,
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: provider,
      providerInstanceId,
      providerSessionId,
      title: "Imported thread",
      model: modelSelection.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      omittedMessageCount: 0,
      messages: [
        { role: "user" as const, text: "Fix it", createdAt: timestamp },
        { role: "assistant" as const, text: "Fixed", createdAt: timestamp },
      ],
    },
  } satisfies AgentSessionScanner.AgentSessionRecentThread;
}

const PI_MODEL_SELECTION = { instanceId: ProviderInstanceId.make("pi"), model: "default" };

it.effect.each(["codex-shared", undefined] as const)(
  "protects %s shared owners during manual T3 project import",
  (ownerType) =>
    Effect.gen(function* () {
      const source = candidate(CODEX_MODEL_SELECTION, "shared-in-t3-project");
      // An ordinary owner must not hide the shared owner from the collision query.
      const ordinaryId = yield* seedOwner(source, "active", "t3");
      const desktopSource = candidate(
        {
          ...CODEX_MODEL_SELECTION,
          instanceId: ProviderInstanceId.make(
            ownerType === undefined ? "codex-desktop" : "codex-custom-shared",
          ),
        },
        source.source.providerSessionId,
      );
      const sharedId = yield* seedOwner(desktopSource, "active", ownerType);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const before = yield* Effect.forEach([ordinaryId, sharedId], (id) =>
        projections.getThreadRecords(id, ["providerThreads", "messages"]),
      );
      const importer = yield* makeImporter(
        [source],
        Effect.void,
        ServerSettings.layerTest(),
        undefined,
        undefined,
        () => ({ defaultThreadType: "t3" }),
      );
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(
        yield* Effect.forEach([ordinaryId, sharedId], (id) =>
          projections.getThreadRecords(id, ["providerThreads", "messages"]),
        ),
      ).toEqual(before);
      expect(importer.published).toEqual([]);
      expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "checks shared owners created after a manual import scan inside the commit transaction",
  () =>
    Effect.gen(function* () {
      const source = candidate(CODEX_MODEL_SELECTION, "shared-at-commit");
      const sharedSource = candidate(
        { ...CODEX_MODEL_SELECTION, instanceId: ProviderInstanceId.make("codex-desktop") },
        source.source.providerSessionId,
      );
      let ownerId: ThreadId | undefined;
      const sink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const importer = yield* makeImporter(
        [source],
        Effect.gen(function* () {
          ownerId ??= yield* seedOwner(sharedSource, "active", "codex-shared");
        }).pipe(
          Effect.provideService(EventSink.EventSinkV2, sink),
          Effect.provideService(IdAllocator.IdAllocatorV2, ids),
          Effect.orDie,
        ),
        ServerSettings.layerTest(),
        undefined,
        undefined,
        () => ({ defaultThreadType: "t3" }),
      );
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(ownerId).toBeDefined();
      expect(importer.published).toEqual([]);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("keeps ordinary Codex imports independent across provider instances", () =>
  Effect.gen(function* () {
    const source = candidate(CODEX_MODEL_SELECTION, "ordinary-collision");
    const otherSource = candidate(
      { ...CODEX_MODEL_SELECTION, instanceId: ProviderInstanceId.make("codex-other") },
      source.source.providerSessionId,
    );
    const ownerId = yield* seedOwner(otherSource, "active", "t3");
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const before = yield* projections.getThreadRecords(ownerId, ["providerThreads", "messages"]);
    const importer = yield* makeImporter(
      [source],
      Effect.void,
      ServerSettings.layerTest(),
      undefined,
      undefined,
      () => ({ defaultThreadType: "t3" }),
    );
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
    expect(yield* projections.getThreadRecords(ownerId, ["providerThreads", "messages"])).toEqual(
      before,
    );
    expect((yield* projections.getThread(importId(source))).providerInstanceId).toBe(
      source.source.providerInstanceId,
    );
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect.each(["codex", "codex-desktop"])(
  "does not create shared bindings through the legacy disk importer: %s",
  (instanceId) =>
    Effect.gen(function* () {
      const source = candidate(
        { ...CODEX_MODEL_SELECTION, instanceId: ProviderInstanceId.make(instanceId) },
        "new-disk-id",
      );
      const importer = yield* makeImporter(
        [source],
        Effect.void,
        ServerSettings.layerTest(),
        undefined,
        undefined,
        () => ({ defaultThreadType: "codex-shared" }),
      );
      expect(yield* importer.refresh({ projectId })).toEqual({ importedCount: 0, skippedCount: 1 });
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("skips a shared import when another provider already tracks the native ID", () =>
  Effect.gen(function* () {
    const desktopSource = candidate(
      { ...CODEX_MODEL_SELECTION, instanceId: ProviderInstanceId.make("codex-desktop") },
      "shared-id",
    );
    const ownerId = yield* seedOwner(desktopSource, "active", "codex-shared");
    const source = candidate(CODEX_MODEL_SELECTION, "shared-id");
    const importer = yield* makeImporter(
      [source],
      Effect.void,
      ServerSettings.layerTest(),
      undefined,
      undefined,
      () => ({ defaultThreadType: "codex-shared" }),
    );
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const before = yield* projections.getThreadRecords(ownerId, ["providerThreads", "messages"]);
    expect(yield* importer.refresh({ projectId, discoverOnly: true })).toEqual({
      importedCount: 0,
      skippedCount: 1,
    });
    expect(yield* projections.getThreadRecords(ownerId, ["providerThreads", "messages"])).toEqual(
      before,
    );
    expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

// Pi threads are owned by their session file path, not the session UUID.
const nativeId = ({ source }: ReturnType<typeof candidate>) =>
  source.provider === "pi" ? source.filePath : source.providerSessionId;

function importId(source: ReturnType<typeof candidate>) {
  return ThreadId.make(
    `import:${source.source.providerInstanceId}:${source.source.providerSessionId}`,
  );
}

const seedOwner = Effect.fn(function* (
  source: ReturnType<typeof candidate>,
  lifecycle: "active" | "archived" | "deleted" = "active",
  threadType?: "t3" | "codex-shared",
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const { providerInstanceId, providerSessionId, provider } = source.source;
  const nativeThreadId = nativeId(source);
  const threadId = ThreadId.make(`owner:${providerInstanceId}:${providerSessionId}`);
  const driver = ProviderDriverKind.make(provider);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({ driver, providerInstanceId, nativeThreadId }),
    driver,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    ...(threadType === undefined ? {} : { threadType }),
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Native thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: source.thread.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: lifecycle === "archived" ? now : null,
    deletedAt: lifecycle === "deleted" ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
    ],
  });
  return threadId;
});

const makeImporter = Effect.fn(function* (
  candidates: ReadonlyArray<ReturnType<typeof candidate>>,
  beforeTransaction: Effect.Effect<void> = Effect.void,
  settings: Layer.Layer<
    ServerSettings.ServerSettingsService,
    ServerSettingsError
  > = ServerSettings.layerTest(),
  history?: (nativeThreadId: string) => CodexSessionHistory.CodexHistory,
  scanned?: () => ReadonlyArray<AgentSessionScanner.AgentSessionRecentThread>,
  projectOverrides?: () => Partial<import("@t3tools/contracts").Project>,
) {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const published: Array<ApplicationStoredEvent> = [];
  const withTransaction: typeof sql.withTransaction = (effect) =>
    beforeTransaction.pipe(Effect.andThen(sql.withTransaction(effect)));
  const importSql = new Proxy(sql, {
    get: (target, key, receiver) =>
      key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
  });
  const sinkLayer = Layer.fresh(EventSink.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, importSql),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(EventStore.EventStoreV2, {
          ...events,
          publishCommitted: (batch) =>
            events.publishCommitted(batch).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  published.push(...batch);
                }),
              ),
            ),
        }),
      ),
    ),
  );
  const context = yield* Layer.build(
    AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          sinkLayer,
          settings,
          Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
          Layer.succeed(CodexSessionHistory.CodexSessionHistory, {
            read: ({ nativeThreadId }) =>
              Effect.sync(
                () =>
                  history?.(nativeThreadId) ?? {
                    nativeThreadId,
                    messages: candidates
                      .find((candidate) => candidate.thread.providerSessionId === nativeThreadId)!
                      .thread.messages.map((message, index) => ({
                        ...message,
                        turnId: "native-turn",
                        itemId: `native-item-${index}`,
                      })),
                    omittedItemTypes: [],
                  },
              ),
          }),
          Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
          Layer.succeed(
            ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
          ),
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({
            recentThreads: () =>
              Stream.fromIterable<AgentSessionScanner.AgentSessionRecentThread>(
                scanned?.() ?? candidates,
              ),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.sync(() =>
                Option.some({
                  id: projectId,
                  title: "Project",
                  workspaceRoot: "/workspace/project",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: timestamp,
                  updatedAt: timestamp,
                  deletedAt: null,
                  ...projectOverrides?.(),
                }),
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
        ),
      ),
    ),
  );
  const importer = Context.get(context, AgentSessionImporter.AgentSessionImporter);
  return {
    run: importer.importRecentAgentThreads({ projectId }),
    refresh: importer.importRecentAgentThreads,
    published,
  };
});

it.effect(
  "reuses native Codex owners, preserves archived and deleted threads, and imports other instances",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const active = candidate(CODEX_MODEL_SELECTION, "active");
      const archived = candidate(
        CLAUDE_MODEL_SELECTION,
        "020e7f00-dce6-406b-8ec6-ed90498945d6",
        "claudeAgent",
      );
      const deleted = candidate(CODEX_MODEL_SELECTION, "deleted");
      const ownedPi = candidate(PI_MODEL_SELECTION, "owned-pi", "pi");
      const owners = [
        yield* seedOwner(active),
        yield* seedOwner(archived, "archived"),
        yield* seedOwner(deleted, "deleted"),
        yield* seedOwner(ownedPi),
      ];
      const before = yield* Effect.forEach(owners, (id) =>
        projections.getThreadRecords(id, ["providerThreads"]),
      );
      const otherInstance = candidate(
        { ...CLAUDE_MODEL_SELECTION, instanceId: ProviderInstanceId.make("claude-other") },
        archived.source.providerSessionId,
        "claudeAgent",
      );
      const unowned = candidate(CODEX_MODEL_SELECTION, "unowned");
      otherInstance.thread.omittedMessageCount = 1;
      const unownedPi = candidate(PI_MODEL_SELECTION, "unowned-pi", "pi");
      const importer = yield* makeImporter([
        active,
        archived,
        deleted,
        ownedPi,
        otherInstance,
        unowned,
        unownedPi,
      ]);

      expect(yield* importer.run).toEqual({ importedCount: 4, skippedCount: 0 });
      for (const source of [active, archived, deleted, ownedPi]) {
        const threadId = importId(source);
        expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
        expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
        expect(yield* runtimes.getByThreadId({ threadId })).toEqual(Option.none());
      }
      expect(
        yield* Effect.forEach(owners, (id) =>
          projections.getThreadRecords(id, ["providerThreads"]),
        ),
      ).toEqual(before);
      expect(
        new Set(
          importer.published.flatMap((stored) =>
            "event" in stored ? [stored.event.threadId] : [],
          ),
        ),
      ).toEqual(
        new Set([owners[0], importId(otherInstance), importId(unowned), importId(unownedPi)]),
      );
      for (const source of [otherInstance, unowned, unownedPi]) {
        const threadId = importId(source);
        const records = yield* projections.getThreadRecords(threadId, [
          "messages",
          "turnItems",
          "providerThreads",
        ]);
        expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
        const notices = records.turnItems.filter((item) => item.type === "system_notice");
        if (source === otherInstance) {
          expect(records.turnItems[0]).toBe(notices[0]);
          expect(notices).toMatchObject([
            {
              ordinal: 1,
              runId: null,
              message: expect.stringContaining("1 earlier message was not imported"),
            },
          ]);
        } else {
          expect(notices).toEqual([]);
        }
        expect(records.thread.historyOrigin).toBe("v1_import");
        expect(records.thread.activeProviderThreadId).toBe(records.providerThreads[0]?.id);
        expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(nativeId(source));
        expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
          providerInstanceId: source.source.providerInstanceId,
          resumeCursor:
            source.source.provider === "claudeAgent"
              ? { threadId, resume: source.source.providerSessionId }
              : { threadId: nativeId(source) },
          runtimePayload: { importedTranscripts: [source.source] },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("refreshes only the selected native shared thread without rescanning other chats", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const source = candidate(CODEX_MODEL_SELECTION, "selected-native");
    const threadId = yield* seedOwner(source, "active", "codex-shared");
    expect(yield* projections.listSharedNativeThreads()).toEqual([{ threadId, projectId }]);
    const importer = yield* makeImporter(
      [source],
      Effect.void,
      ServerSettings.layerTest(),
      undefined,
      () => {
        throw new Error("Targeted refresh must not scan unrelated chats");
      },
    );
    expect(yield* importer.refresh({ projectId, threadId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.refresh({ projectId, threadId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    const records = yield* projections.getThreadRecords(threadId, ["messages", "providerThreads"]);
    expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
    expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(nativeId(source));
    expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "background discovery preserves a T3-owned native conversation without reading or rewriting its history",
  () =>
    Effect.gen(function* () {
      const source = candidate(CODEX_MODEL_SELECTION, "owned-native");
      const ownerId = yield* seedOwner(source);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const before = yield* projections.getThreadRecords(ownerId, ["messages", "providerThreads"]);
      const importer = yield* makeImporter(
        [source],
        Effect.void,
        ServerSettings.layerTest(),
        () => {
          throw new Error("Owned histories are outside background discovery");
        },
      );
      expect(yield* importer.refresh({ projectId, discoverOnly: true })).toEqual({
        importedCount: 0,
        skippedCount: 0,
      });
      expect(importer.published).toEqual([]);
      expect(yield* projections.getThreadRecords(ownerId, ["messages", "providerThreads"])).toEqual(
        before,
      );
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect.each(["pending", "unknown", "rebind", "active-run", "commit-failure"] as const)(
  "blocks a send when targeted native history cannot be committed safely (%s)",
  (condition) =>
    Effect.gen(function* () {
      const source = candidate(CODEX_MODEL_SELECTION, "targeted-safety");
      const threadId = yield* seedOwner(source, "active", "codex-shared");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const owner = (yield* projections.getThreadRecords(threadId, ["providerThreads"]))
        .providerThreads[0]!;
      const writeOwner = (payload: OrchestrationV2ProviderThread) =>
        eventSink.write({
          events: [
            {
              id: EventId.make("targeted:owner-change"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload,
            },
          ],
        });
      if (condition === "pending" || condition === "unknown")
        yield* writeOwner({
          ...owner,
          nativeMetadata: {
            codexShared: true,
            codexSharedRelease: {
              state: condition,
              generation: "original-release",
              nativeId: nativeId(source),
            },
          },
        });
      if (condition === "commit-failure")
        yield* sql`CREATE TEMP TRIGGER fail_targeted BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'message.updated' BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`;
      let reads = 0;
      const result = yield* refreshSharedNativeHistory({
        threadId,
        projectId,
        workspaceRoot: "/workspace/project",
        projections,
        eventSink,
        beforeSend: true,
        history: {
          read: () =>
            Effect.gen(function* () {
              reads++;
              if (condition === "rebind")
                yield* writeOwner({
                  ...owner,
                  nativeThreadRef: { ...owner.nativeThreadRef!, nativeId: "different-native-id" },
                });
              if (condition === "active-run")
                yield* eventSink.write({
                  events: [
                    {
                      id: EventId.make("targeted:active-run"),
                      type: "run.updated",
                      threadId,
                      occurredAt: now,
                      payload: {
                        id: RunId.make("racing-run"),
                        threadId,
                        ordinal: 1,
                        providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                        modelSelection: CODEX_MODEL_SELECTION,
                        providerThreadId: owner.id,
                        userMessageId: MessageId.make("racing-input"),
                        rootNodeId: null,
                        activeAttemptId: null,
                        status: "running",
                        requestedAt: now,
                        startedAt: now,
                        completedAt: null,
                        checkpointId: null,
                        contextHandoffId: null,
                      },
                    },
                  ],
                });
              return {
                nativeThreadId: nativeId(source),
                messages: [
                  {
                    turnId: "external",
                    itemId: "answer",
                    role: "assistant" as const,
                    text: "New history",
                    createdAt: timestamp,
                  },
                ],
                omittedItemTypes: [],
              };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new CodexSessionHistory.CodexSessionHistoryError({
                    nativeThreadId: nativeId(source),
                    cause,
                  }),
              ),
            ),
        },
      }).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      expect(reads).toBe(condition === "pending" || condition === "unknown" ? 0 : 1);
      expect((yield* projections.getThreadRecords(threadId, ["messages"])).messages).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "rotates background discovery so changing or failed early files cannot starve later native chats",
  () =>
    Effect.gen(function* () {
      const sources = Array.from({ length: 11 }, (_, index) =>
        candidate(CODEX_MODEL_SELECTION, `background-${String(index).padStart(2, "0")}`),
      );
      const reads: string[] = [];
      const importer = yield* makeImporter(
        sources,
        Effect.void,
        ServerSettings.layerTest(),
        (nativeThreadId) => {
          reads.push(nativeThreadId);
          return { nativeThreadId, messages: [], omittedItemTypes: [] };
        },
        undefined,
        () => ({ defaultThreadType: "codex-shared" }),
      );
      yield* importer.refresh({ projectId, discoverOnly: true });
      expect(reads).toHaveLength(10);
      expect(reads).not.toContain("background-10");
      yield* importer.refresh({ projectId, discoverOnly: true });
      expect(reads).toContain("background-10");
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "upserts native items across repeated scans, same-turn completion and failed commits",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const source = candidate(CODEX_MODEL_SELECTION, "incremental");
      let messages: CodexSessionHistory.CodexHistoryMessage[] = [
        { turnId: "turn-1", itemId: "u1", role: "user", text: "Same text", createdAt: timestamp },
        { turnId: "turn-1", itemId: "a1", role: "assistant", text: "Part", createdAt: timestamp },
      ];
      const importer = yield* makeImporter(
        [source],
        Effect.void,
        ServerSettings.layerTest(),
        () => ({ nativeThreadId: source.thread.providerSessionId, messages, omittedItemTypes: [] }),
      );
      const threadId = importId(source);
      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      const initial = yield* projections.getThreadRecords(threadId, ["messages", "turnItems"]);
      const count = importer.published.length;
      yield* importer.run;
      expect(importer.published).toHaveLength(count);
      messages = [
        messages[0]!,
        { ...messages[1]!, text: "Part completed" },
        { turnId: "turn-2", itemId: "u2", role: "user", text: "Same text", createdAt: timestamp },
      ];
      source.source.size = 200;
      yield* sql`CREATE TEMP TRIGGER fail_delta BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'message.updated' BEGIN SELECT RAISE(ABORT, 'test delta failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect((yield* projections.getThreadRecords(threadId, ["messages"])).messages).toEqual(
        initial.messages,
      );
      expect(
        Option.getOrThrow(yield* runtimes.getByThreadId({ threadId })).runtimePayload,
      ).toMatchObject({ importedTranscripts: [{ size: 100 }] });
      yield* sql`DROP TRIGGER fail_delta`;
      yield* importer.run;
      const updated = yield* projections.getThreadRecords(threadId, ["messages", "turnItems"]);
      expect(updated.messages.map((message) => message.text)).toEqual([
        "Same text",
        "Part completed",
        "Same text",
      ]);
      expect(updated.messages.slice(0, 2).map((message) => message.id)).toEqual(
        initial.messages.map((message) => message.id),
      );
      expect(updated.turnItems.slice(0, 2).map((item) => item.id)).toEqual(
        initial.turnItems.map((item) => item.id),
      );
      const committed = importer.published.length;
      messages = [messages[0]!, { ...messages[1]!, text: "Part" }];
      yield* importer.run;
      expect(importer.published).toHaveLength(committed);
      expect((yield* projections.getThreadRecords(threadId, ["messages"])).messages).toEqual(
        updated.messages,
      );
      messages = [{ ...messages[1]!, text: "Stale divergent version" }];
      source.source.size = 300;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(importer.published).toHaveLength(committed);
      expect(
        Option.getOrThrow(yield* runtimes.getByThreadId({ threadId })).runtimePayload,
      ).toMatchObject({ importedTranscripts: [{ size: 200 }] });
      expect(updated.turnItems.filter((item) => item.type === "assistant_message")).toMatchObject([
        { status: "idle", completedAt: null },
      ]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "reconciles an unchanged file fingerprint after the reader initially sees partial history",
  () =>
    Effect.gen(function* () {
      const source = candidate(CODEX_MODEL_SELECTION, "same-file-partial-read");
      let imported = false;
      let reads = 0;
      const importer = yield* makeImporter(
        [source],
        Effect.void,
        ServerSettings.layerTest(),
        () => ({
          nativeThreadId: source.thread.providerSessionId,
          messages: [
            {
              turnId: "same-turn",
              itemId: "user",
              role: "user",
              text: "Prompt",
              createdAt: timestamp,
            },
            ...(++reads === 1
              ? []
              : [
                  {
                    turnId: "same-turn",
                    itemId: "reply",
                    role: "assistant" as const,
                    text: "Complete reply",
                    createdAt: timestamp,
                  },
                ]),
          ],
          omittedItemTypes: [],
        }),
        () => (imported ? [{ _tag: "AlreadyImported", source: source.source }] : [source]),
      );
      yield* importer.run;
      imported = true;
      yield* importer.run;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      expect(
        (yield* projections.getThreadRecords(importId(source), ["messages"])).messages.map(
          (message) => message.text,
        ),
      ).toEqual(["Prompt", "Complete reply"]);
      const count = importer.published.length;
      yield* importer.run;
      expect(reads).toBe(3);
      expect(importer.published).toHaveLength(count);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("advances discovery past 100 sessions while rotating unchanged history reads", () =>
  Effect.gen(function* () {
    const sources = Array.from({ length: 101 }, (_, index) =>
      candidate(CODEX_MODEL_SELECTION, `native-${String(index).padStart(3, "0")}`),
    );
    const known = new Set<string>();
    const reads = new Map<string, number>();
    const importer = yield* makeImporter(
      sources,
      Effect.void,
      ServerSettings.layerTest(),
      (nativeThreadId) => {
        reads.set(nativeThreadId, (reads.get(nativeThreadId) ?? 0) + 1);
        return {
          nativeThreadId,
          messages: [
            { turnId: "turn", itemId: "user", role: "user", text: "Prompt", createdAt: timestamp },
          ],
          omittedItemTypes: [],
        };
      },
      () =>
        sources.map((source) =>
          known.has(source.thread.providerSessionId)
            ? { _tag: "AlreadyImported", source: source.source }
            : source,
        ),
    );
    expect(yield* importer.run).toEqual({ importedCount: 100, skippedCount: 1 });
    for (const source of sources.slice(0, 100)) known.add(source.thread.providerSessionId);
    expect(yield* importer.run).toEqual({ importedCount: 101, skippedCount: 0 });
    known.add(sources[100]!.thread.providerSessionId);
    const count = importer.published.length;
    yield* importer.run;
    expect(reads.get("native-100")).toBe(2);
    expect(importer.published).toHaveLength(count);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    expect(
      (yield* projections.getThreadRecords(importId(sources[100]!), ["messages"])).messages.map(
        (message) => message.text,
      ),
    ).toEqual(["Prompt"]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "positions external native observations between local runs without assigning them to either run",
  () =>
    Effect.gen(function* () {
      const source = candidate(CODEX_MODEL_SELECTION, "interleaved-history");
      const threadId = yield* seedOwner(source, "active", "codex-shared");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const owner = (yield* projections.getThreadRecords(threadId, ["providerThreads"]))
        .providerThreads[0]!;
      for (const ordinal of [1, 2]) {
        const runId = RunId.make(`local-run-${ordinal}`),
          nodeId = NodeId.make(`local-node-${ordinal}`);
        yield* sink.write({
          events: [
            {
              id: EventId.make(`order:run:${ordinal}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                modelSelection: CODEX_MODEL_SELECTION,
                providerThreadId: owner.id,
                userMessageId: MessageId.make(`local-user-${ordinal}`),
                rootNodeId: nodeId,
                activeAttemptId: null,
                status: "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`order:turn:${ordinal}`),
              type: "provider-turn.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: ProviderTurnId.make(`provider-turn-${ordinal}`),
                providerThreadId: owner.id,
                nodeId,
                runAttemptId: null,
                nativeTurnRef: {
                  driver: owner.driver,
                  nativeId: `local-native-${ordinal}`,
                  strength: "strong",
                },
                ordinal,
                status: "completed",
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make(`order:item:${ordinal}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`local-item-${ordinal}`),
                threadId,
                runId,
                nodeId,
                providerThreadId: owner.id,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "assistant_message",
                messageId: MessageId.make(`local-message-${ordinal}`),
                text: `Local ${ordinal}`,
                streaming: false,
              },
            },
          ],
        });
      }
      let phase = 0;
      const importer = yield* makeImporter(
        [source],
        Effect.void,
        ServerSettings.layerTest(),
        () => ({
          nativeThreadId: nativeId(source),
          // Local turns can contain only tools or compaction, so they have no text here.
          turnIds:
            phase === 4
              ? ["external", "local-native-2"]
              : phase === 3
                ? ["external", "local-native-1", "local-native-2"]
                : ["local-native-1", "external", "local-native-2"],
          omittedItemTypes: [],
          messages: [
            ...(phase === 0 || phase === 2
              ? []
              : [
                  {
                    turnId: "external",
                    itemId: "two",
                    role: "user" as const,
                    text: "External prompt",
                    createdAt: timestamp,
                  },
                ]),
            {
              turnId: "external",
              itemId: "three",
              role: "assistant" as const,
              text: phase === 1 ? "External" : "External reply",
              createdAt: timestamp,
            },
          ],
        }),
      );
      yield* importer.run;
      const partialItems = (yield* projections.getThreadRecords(threadId, ["turnItems"])).turnItems;
      expect(partialItems.map((item) => ("text" in item ? item.text : item.type))).toEqual([
        "Local 1",
        "External reply",
        "Local 2",
      ]);
      phase = 1;
      yield* importer.run;
      const items = (yield* projections.getThreadRecords(threadId, ["turnItems"])).turnItems;
      expect(items.map((item) => ("text" in item ? item.text : item.type))).toEqual([
        "Local 1",
        "External prompt",
        "External reply",
        "Local 2",
      ]);
      expect(items.slice(1, 3).map((item) => item.runId)).toEqual([null, null]);
      const count = importer.published.length;
      yield* importer.run;
      expect(importer.published).toHaveLength(count);
      phase = 2;
      yield* importer.run;
      expect(importer.published).toHaveLength(count);
      phase = 4;
      yield* importer.run;
      // All external item IDs are present, but a missing tool-only local anchor
      // still makes this partial; it must not move observations before Local 1.
      expect(importer.published).toHaveLength(count);
      phase = 3;
      const reconciledAt = DateTime.makeUnsafe("2026-09-01T10:01:00.000Z");
      Object.assign(source.thread, { updatedAt: DateTime.formatIso(reconciledAt) });
      yield* importer.run;
      const reorderedUser = (yield* projections.getThreadRecords(threadId, [
        "messages",
      ])).messages.find((message) => message.role === "user")!;
      expect(reorderedUser.createdAt).toEqual(now);
      expect(reorderedUser.updatedAt).toEqual(reconciledAt);
      const reordered = (yield* projections.getThreadRecords(threadId, ["turnItems"])).turnItems;
      expect(reordered.map((item) => ("text" in item ? item.text : item.type))).toEqual([
        "External prompt",
        "External reply",
        "Local 1",
        "Local 2",
      ]);
      const replay = yield* ProjectionReplay.ProjectionReplay;
      expect((yield* replay.rebuild).valid).toBe(true);
      expect((yield* projections.getThreadRecords(threadId, ["turnItems"])).turnItems).toEqual(
        reordered,
      );
      const sql = yield* SqlClient.SqlClient;
      expect(
        yield* sql`SELECT turn_item_id, ordinal FROM orchestration_v2_turn_item_positions WHERE thread_id = ${threadId} ORDER BY ordinal`,
      ).toEqual(reordered.map((item) => ({ turn_item_id: item.id, ordinal: item.ordinal })));
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rechecks local work inside the history transaction without changing thread policy", () =>
  Effect.gen(function* () {
    const source = candidate(CODEX_MODEL_SELECTION, "local-race");
    const ownerId = yield* seedOwner(source);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const before = yield* projections.getThreadRecords(ownerId, ["providerThreads"]);
    const entering = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const importer = yield* makeImporter(
      [source],
      Deferred.succeed(entering, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    const pending = yield* Effect.forkScoped(importer.run);
    yield* Deferred.await(entering);
    yield* sink.write({
      events: [
        {
          id: EventId.make("race:run"),
          type: "run.updated",
          threadId: ownerId,
          occurredAt: now,
          payload: {
            id: RunId.make("local-run"),
            threadId: ownerId,
            ordinal: 1,
            providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
            modelSelection: CODEX_MODEL_SELECTION,
            providerThreadId: before.providerThreads[0]!.id,
            userMessageId: MessageId.make("local-user"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(pending)).toEqual({ importedCount: 0, skippedCount: 1 });
    expect((yield* projections.getThreadRecords(ownerId, ["messages"])).messages).toEqual([]);
    expect((yield* projections.getThreadRecords(ownerId, ["providerThreads"])).thread).toEqual(
      before.thread,
    );
    expect(importer.published).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("keeps ordinal-only legacy imports unchanged until an explicit migration", () =>
  Effect.gen(function* () {
    const source = candidate(CODEX_MODEL_SELECTION, "legacy-import");
    const threadId = yield* seedOwner(source);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const thread = yield* projections.getThread(threadId);
    yield* sink.write({
      events: [
        {
          id: EventId.make("legacy:thread"),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...thread, historyOrigin: "v1_import", runtimeMode: "approval-required" },
        },
        {
          id: EventId.make("legacy:message"),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: MessageId.make(`${threadId}:000000`),
            threadId,
            createdBy: "user",
            creationSource: "server",
            role: "user",
            text: "Legacy text",
            attachments: [],
            runId: null,
            nodeId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    const before = yield* projections.getThreadRecords(threadId, ["messages", "providerThreads"]);
    const importer = yield* makeImporter([source]);
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
    expect(yield* projections.getThreadRecords(threadId, ["messages", "providerThreads"])).toEqual(
      before,
    );
    expect(importer.published).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect.each(["owner", "type", "workspace", "archived"] as const)(
  "background discovery rechecks project and ownership after native IO (%s)",
  (condition) =>
    Effect.gen(function* () {
      const entering = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const source = candidate(CODEX_MODEL_SELECTION, "discovery-race");
      let changed = false;
      const importer = yield* makeImporter(
        [source],
        Deferred.succeed(entering, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
        ServerSettings.layerTest(),
        undefined,
        undefined,
        () => ({
          defaultThreadType: changed && condition === "type" ? "t3" : "codex-shared",
          workspaceRoot:
            changed && condition === "workspace" ? "/workspace/changed" : "/workspace/project",
          archivedAt: changed && condition === "archived" ? timestamp : null,
        }),
      );
      const running = yield* Effect.forkScoped(importer.refresh({ projectId, discoverOnly: true }));
      yield* Deferred.await(entering);
      changed = true;
      const ownerId = condition === "owner" ? yield* seedOwner(source, "active", "t3") : undefined;
      yield* Deferred.succeed(proceed, undefined);
      expect(yield* Fiber.join(running)).toEqual({ importedCount: 0, skippedCount: 0 });
      expect(importer.published).toEqual([]);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
      if (ownerId) {
        const records = yield* projections.getThreadRecords(ownerId, ["messages"]);
        expect(records.thread.threadType).toBe("t3");
        expect(records.messages).toEqual([]);
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rechecks ownership after the import reaches the commit transaction", () =>
  Effect.gen(function* () {
    const enteringTransaction = yield* Deferred.make<void>();
    const continueTransaction = yield* Deferred.make<void>();
    const source = candidate(CODEX_MODEL_SELECTION, "claimed-during-import");
    const importer = yield* makeImporter(
      [source],
      Deferred.succeed(enteringTransaction, undefined).pipe(
        Effect.andThen(Deferred.await(continueTransaction)),
      ),
    );
    const pending = yield* Effect.forkScoped(importer.run);
    yield* Deferred.await(enteringTransaction);
    // Commit ownership after all pre-transaction reads, before the import acquires SQLite.
    const ownerId = yield* seedOwner(source);
    yield* Deferred.succeed(continueTransaction, undefined);
    expect(yield* Fiber.join(pending)).toEqual({ importedCount: 1, skippedCount: 0 });
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    expect(yield* events.read({ threadId: importId(source) }).pipe(Stream.runCollect)).toEqual([]);
    expect(yield* runtimes.list()).toEqual([]);
    expect(importer.published).toHaveLength(4);
    expect(
      (yield* projections.getThreadRecords(ownerId, ["providerThreads"])).providerThreads[0]
        ?.appThreadId,
    ).toBe(ownerId);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "retries failed commits and runtime persistence without replaying committed history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const source = candidate(CODEX_MODEL_SELECTION, "retry");
      const threadId = importId(source);
      const importer = yield* makeImporter([source]);
      yield* sql`CREATE TEMP TRIGGER fail_import BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'message.updated' BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
      expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
      expect(yield* runtimes.list()).toEqual([]);
      expect(importer.published).toEqual([]);
      yield* sql`DROP TRIGGER fail_import`;

      yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
      expect(importer.published).toEqual([]);
      expect(yield* runtimes.list()).toEqual([]);
      yield* sql`DROP TRIGGER fail_runtime`;

      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      const committed = yield* events.read({ threadId }).pipe(Stream.runCollect);
      expect(committed).toHaveLength(6);
      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual(committed);
      expect(importer.published).toHaveLength(6);
      expect(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
          (message) => message.text,
        ),
      ).toEqual(["Fix it", "Fixed"]);
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
        providerInstanceId: source.source.providerInstanceId,
        resumeCursor: { threadId: source.source.providerSessionId },
        runtimePayload: { importedTranscripts: [source.source] },
      });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("imports under a policy ceiling in the project's default, kept under the ceiling", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const source = candidate(CODEX_MODEL_SELECTION, "ceiling");
    const threadId = importId(source);
    const importer = yield* makeImporter(
      [source],
      Effect.void,
      ServerSettings.layerTest(
        { defaultRuntimeMode: "full-access" },
        {
          organization: "Example Corp",
          lockedSettings: [],
          limits: { maxRuntimeMode: "auto-accept-edits" },
        },
      ),
    );
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
    expect((yield* projections.getThread(threadId)).runtimeMode).toBe("auto-accept-edits");
    expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId })).runtimeMode).toBe(
      "auto-accept-edits",
    );
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);
