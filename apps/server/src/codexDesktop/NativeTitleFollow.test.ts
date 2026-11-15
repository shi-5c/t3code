import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Contracts from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ServerConfig } from "../config.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import * as Runtime from "../orchestration-v2/runtimeLayer.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as Commands from "../orchestration-v2/ThreadCommandExecutor.ts";
import { DesktopHistoryLibrary } from "./DesktopHistoryLibrary.ts";
import * as Follow from "./NativeTitleFollow.ts";
import { queueSharedTitle, observeSavedTitle, observeSharedTitle } from "./sharedTitle.ts";

const decodeThread = Schema.decodeUnknownEffect(Contracts.OrchestrationV2AppThread);
const decodeProvider = Schema.decodeUnknownEffect(Contracts.OrchestrationV2ProviderThread);
const base = Layer.mergeAll(
  Runtime.layerEventSink,
  Projections.layer,
  Commands.layer,
  ServerConfig.layerTest("/workspace", { prefix: "t3-title-follow-" }),
).pipe(Layer.provide(Persistence.layerMemory), Layer.provideMerge(NodeServices.layer));

const fixture = Effect.gen(function* () {
  const sink = yield* Sink.EventSinkV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const commits = yield* Queue.unbounded<void>();
  const starts = yield* Queue.unbounded<string>();
  const releaseRead = yield* Deferred.make<void>();
  const controls = {
    sourceId: "source",
    name: "A",
    revision: 0,
    allowed: true,
    internal: false,
    hold: false,
    active: 0,
    peak: 0,
    closed: 0,
    committed: 0,
    epoch: "epoch",
    replay: null as Contracts.CodexNativeTitleRead | null,
  };
  const latestReads = new Map<string, Contracts.CodexNativeTitleRead>();
  let sequence = 0;
  const update = Effect.fn("TitleFixture.update")(function* (
    thread: Contracts.OrchestrationV2AppThread,
  ) {
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: Contracts.EventId.make(`change-${sequence++}`),
          type: "thread.metadata-updated",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
  });
  const seed = Effect.fn("TitleFixture.seed")(function* (name: string) {
    const now = yield* DateTime.now;
    const threadId = Contracts.ThreadId.make(name);
    const providerId = Contracts.ProviderThreadId.make(`${name}-provider`);
    const thread = yield* decodeThread({
      id: threadId,
      projectId: "project",
      title: "A",
      threadType: "codex-shared",
      codexSharedOwner: "native",
      providerInstanceId: "codex-desktop",
      modelSelection: { instanceId: "codex-desktop", model: "fixture" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "system",
      creationSource: "server",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    });
    const provider = yield* decodeProvider({
      id: providerId,
      driver: "codex",
      providerInstanceId: "codex-desktop",
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver: "codex", nativeId: name, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt: now,
      updatedAt: now,
    });
    yield* sink.write({
      events: [
        {
          id: Contracts.EventId.make(`${name}-created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
        {
          id: Contracts.EventId.make(`${name}-provider`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: provider,
        },
      ],
    });
    return threadId;
  });
  const buildFollow = Effect.gen(function* () {
    return Context.get(
      yield* Layer.build(
        Follow.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(DesktopHistoryLibrary)({
                mayProject: (sourceId, nativeId) =>
                  Effect.sync(
                    () =>
                      controls.allowed &&
                      sourceId === controls.sourceId &&
                      !(nativeId && controls.internal),
                  ),
                withProjection: (effect) => effect,
                isCurrentTitle: (read, requireHistoryAdmission) =>
                  Effect.sync(
                    () =>
                      controls.allowed &&
                      !(requireHistoryAdmission && controls.internal) &&
                      read.sourceId === controls.sourceId &&
                      JSON.stringify(latestReads.get(read.nativeId)) === JSON.stringify(read),
                  ),
                observeTitle: (nativeId) =>
                  Effect.gen(function* () {
                    yield* Effect.acquireRelease(
                      Effect.sync(() => {
                        controls.active++;
                        controls.peak = Math.max(controls.peak, controls.active);
                      }),
                      () =>
                        Effect.sync(() => {
                          controls.active--;
                          controls.closed++;
                        }),
                    );
                    yield* Queue.offer(starts, nativeId);
                    if (controls.hold) yield* Deferred.await(releaseRead);
                    if (controls.replay) return controls.replay;
                    const read = {
                      sourceId: controls.sourceId,
                      nativeId,
                      epoch: controls.epoch,
                      revision: ++controls.revision,
                      name: controls.name,
                    };
                    latestReads.set(nativeId, read);
                    return read;
                  }).pipe(Effect.scoped),
              }),
              Layer.succeed(Sink.EventSinkV2, {
                ...sink,
                write: (input) =>
                  sink.write(input).pipe(
                    Effect.tap(() => {
                      controls.committed++;
                      return Queue.offer(commits, undefined);
                    }),
                  ),
              }),
            ),
          ),
        ),
      ),
      Follow.NativeTitleFollow,
    );
  });
  let serviceScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void));
  let follow = yield* buildFollow.pipe(Effect.provideService(Scope.Scope, serviceScope));
  const restart = Effect.gen(function* () {
    yield* Scope.close(serviceScope, Exit.void);
    serviceScope = yield* Scope.make();
    follow = yield* buildFollow.pipe(Effect.provideService(Scope.Scope, serviceScope));
  });
  const open = Effect.fn("TitleFixture.open")(function* (threadId: Contracts.ThreadId) {
    const scope = yield* Scope.make();
    yield* follow.acquire(threadId).pipe(Effect.provideService(Scope.Scope, scope));
    return Scope.close(scope, Exit.void);
  });
  return {
    controls,
    seed,
    open,
    starts,
    commits,
    update,
    releaseRead,
    latestReads,
    restart,
    updateProvider: Effect.fn("TitleFixture.updateProvider")(function* (
      id: Contracts.ThreadId,
      metadata: Contracts.OrchestrationV2ProviderThreadNativeMetadata,
    ) {
      const records = yield* projections.getThreadRecords(id, ["providerThreads"]);
      yield* sink.write({
        events: [
          {
            id: Contracts.EventId.make(`provider-change-${sequence++}`),
            type: "provider-thread.updated",
            threadId: id,
            occurredAt: yield* DateTime.now,
            payload: { ...records.providerThreads[0]!, nativeMetadata: metadata },
          },
        ],
      });
    }),
    read: (id: Contracts.ThreadId) => projections.getThreadRecords(id, ["providerThreads"]),
  };
});

it.effect("deduplicates viewed consumers, follows A-B-C and stops the final reader on close", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const id = yield* f.seed("native");
    const closeOne = yield* f.open(id);
    const closeTwo = yield* f.open(id);
    yield* Queue.take(f.commits);
    assert.equal(f.controls.revision, 1);
    yield* closeOne;
    f.controls.name = "B";
    yield* TestClock.adjust("30 seconds");
    yield* Queue.take(f.commits);
    assert.equal((yield* f.read(id)).thread.title, "B");
    f.controls.name = "C";
    yield* TestClock.adjust("30 seconds");
    yield* Queue.take(f.commits);
    assert.equal((yield* f.read(id)).thread.title, "C");
    f.controls.hold = true;
    yield* TestClock.adjust("30 seconds");
    assert.equal(f.controls.active, 1);
    yield* closeTwo;
    assert.equal(f.controls.active, 0);
    assert.equal(f.controls.closed, 4);
    yield* Deferred.succeed(f.releaseRead, undefined);
    yield* TestClock.adjust("2 minutes");
    assert.equal(f.controls.revision, 3);
    assert.equal(f.controls.peak, 1);
    assert.equal(f.controls.committed, 3);
  }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect("keeps unchanged title reads private without appending metadata events", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const id = yield* f.seed("native");
    const close = yield* f.open(id);
    yield* Queue.take(f.commits);
    const baseline = (yield* f.read(id)).thread;
    yield* TestClock.adjust("1 minute");
    assert.equal(f.controls.revision, 3);
    assert.equal(f.controls.committed, 1);
    assert.deepEqual((yield* f.read(id)).thread, baseline);
    yield* close;
    // A replay newer than the projection but older than the private watermark must still be rejected.
    f.controls.replay = { ...f.latestReads.get("native")!, revision: 2, name: "stale B" };
    yield* f.restart;
    const closeRestart = yield* f.open(id);
    yield* TestClock.adjust("5 seconds");
    assert.deepEqual((yield* f.read(id)).thread, baseline);
    f.controls.replay = null;
    yield* TestClock.adjust("30 seconds");
    assert.equal(f.controls.committed, 1);
    assert.equal(f.controls.revision, 4);
    f.controls.name = "B";
    yield* TestClock.adjust("30 seconds");
    yield* Queue.take(f.commits);
    assert.equal((yield* f.read(id)).thread.title, "B");
    yield* closeRestart;
  }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect.each([
  "manual",
  "disabled",
  "source",
  "cache-candidate",
  "internal",
  "internal-user-created",
] as const)("discards or protects a read overtaken by %s", (reason) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const id = yield* f.seed("native");
    const close = yield* f.open(id);
    yield* Queue.take(f.commits);
    f.controls.hold = true;
    f.controls.name = "B";
    yield* TestClock.adjust("30 seconds");
    assert.equal(f.controls.active, 1);
    const before = (yield* f.read(id)).thread;
    const expected =
      reason === "manual"
        ? "Manual"
        : reason === "cache-candidate" || reason === "internal-user-created"
          ? "B"
          : "A";
    if (reason === "manual")
      yield* f.update({
        ...before,
        title: "Manual",
        ...queueSharedTitle(before, "Manual", "manual"),
      });
    else if (reason === "cache-candidate")
      yield* f.update({
        ...before,
        ...observeSavedTitle(
          {
            ...before,
            codexDesktopHistory: { sourceId: "source", nativeId: "native" } as NonNullable<
              Contracts.OrchestrationV2AppThread["codexDesktopHistory"]
            >,
          },
          {
            sourceId: "source",
            conversationId: "native",
            canonicalTitle: { name: "B", revision: 1, cacheEpoch: "full", snapshot: "hash" },
          } as Contracts.CodexDesktopHistoryEntry,
          true,
          true,
        ),
      });
    else if (reason === "source") f.controls.sourceId = "new-source";
    else if (reason === "internal" || reason === "internal-user-created") {
      f.controls.internal = true;
      if (reason === "internal")
        yield* f.update({
          ...before,
          codexDesktopHistory: {
            sourceId: "source",
            nativeId: "native",
            attachedToThreadId: null,
            fetchedAt: 1,
            membership: {
              kind: "unknown",
              projectId: null,
              projectTitle: null,
              source: "unavailable",
            },
          },
        });
    } else f.controls.allowed = false;
    yield* Deferred.succeed(f.releaseRead, undefined);
    if (reason === "manual" || reason === "cache-candidate" || reason === "internal-user-created")
      yield* Queue.take(f.commits);
    else yield* TestClock.adjust("30 seconds");
    assert.equal((yield* f.read(id)).thread.title, expected);
    assert.equal(f.controls.revision, 2);
    yield* close;
    assert.equal(f.controls.active, 0);
  }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect.each(["epoch", "manual", "unknown"] as const)(
  "publishes changed %s semantics and recovery while suppressing repeated observations",
  (reason) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const id = yield* f.seed("native");
      const close = yield* f.open(id);
      yield* Queue.take(f.commits);
      const baseline = (yield* f.read(id)).thread;
      if (reason === "epoch") f.controls.epoch = "next-epoch";
      else if (reason === "manual")
        yield* f.update({ ...baseline, ...queueSharedTitle(baseline, "A", "manual") });
      else
        yield* f.updateProvider(id, {
          codexNativeTitle: {
            status: "unknown",
            desiredTitle: "A",
            version: 0,
            observedTitle: null,
          },
        });
      yield* TestClock.adjust("30 seconds");
      yield* Queue.take(f.commits);
      const protectedThread = (yield* f.read(id)).thread;
      assert.equal(
        protectedThread.codexTitleSync?.nativeSaved?.state,
        reason === "epoch" ? "baseline" : "candidate",
      );
      yield* TestClock.adjust("30 seconds");
      assert.equal(f.controls.committed, 2);
      assert.deepEqual((yield* f.read(id)).thread, protectedThread);
      if (reason === "unknown")
        yield* f.updateProvider(id, {
          codexNativeTitle: {
            status: "saved",
            desiredTitle: "A",
            version: 0,
            observedTitle: "A",
          },
        });
      if (reason === "manual")
        yield* f.update({
          ...protectedThread,
          ...observeSharedTitle(protectedThread, "A", { epoch: "owner", revision: 1 }),
        });
      yield* TestClock.adjust("30 seconds");
      if (reason !== "epoch") yield* Queue.take(f.commits);
      const recovered = (yield* f.read(id)).thread;
      assert.equal(recovered.codexTitleSync?.nativeSaved?.state, "baseline");
      assert.equal(recovered.codexTitleSync?.status, reason === "manual" ? "confirmed" : "pending");
      yield* TestClock.adjust("30 seconds");
      assert.deepEqual((yield* f.read(id)).thread, recovered);
      const beforeChange = f.controls.committed;
      f.controls.name = "B";
      yield* TestClock.adjust("30 seconds");
      yield* Queue.take(f.commits);
      assert.equal((yield* f.read(id)).thread.title, "B");
      assert.equal(f.controls.committed, beforeChange + 1);
      f.controls.name = "A";
      yield* TestClock.adjust("30 seconds");
      yield* Queue.take(f.commits);
      const conflict = (yield* f.read(id)).thread;
      assert.equal(conflict.title, "B");
      assert.equal(conflict.codexTitleSync?.nativeSaved?.state, "conflict");
      yield* TestClock.adjust("30 seconds");
      assert.deepEqual((yield* f.read(id)).thread, conflict);
      assert.equal(f.controls.committed, beforeChange + 2);
      yield* close;
    }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect("serializes different chats and throttles reopening across consumer lifetimes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const first = yield* f.seed("one");
    const second = yield* f.seed("two");
    const closeOne = yield* f.open(first);
    yield* Queue.take(f.commits);
    const closeTwo = yield* f.open(second);
    yield* TestClock.adjust("4 seconds");
    assert.equal(f.controls.revision, 1);
    yield* TestClock.adjust("1 second");
    yield* Queue.take(f.commits);
    yield* closeOne;
    yield* closeTwo;
    const closeAgain = yield* f.open(first);
    yield* TestClock.adjust("4 seconds");
    assert.equal(f.controls.revision, 2);
    yield* TestClock.adjust("1 second");
    assert.equal(f.controls.revision, 3);
    assert.equal(f.controls.committed, 2);
    assert.equal(f.controls.peak, 1);
    yield* closeAgain;
  }).pipe(Effect.scoped, Effect.provide(base)),
);
