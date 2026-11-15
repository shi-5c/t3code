import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Contracts from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ServerConfig } from "../config.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as ThreadCommands from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Projects from "../project/ProjectService.ts";
import { CodexSessionHistory, type CodexHistory } from "../project/CodexSessionHistory.ts";
import * as Settings from "../serverSettings.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as HistoryLibrary from "./DesktopHistoryLibrary.ts";
import { DesktopHistoryLibrary } from "./DesktopHistoryLibrary.ts";
import { makeDesktopHistoryProjector } from "./DesktopHistoryProjection.ts";
import { observeSharedTitle, queueSharedTitle } from "./sharedTitle.ts";

const layer = Layer.mergeAll(
  RuntimeLayer.layerEventSink,
  Projections.layer,
  ServerConfig.layerTest("/workspace", { prefix: "t3-history-projection-" }),
).pipe(Layer.provide(Persistence.layerMemory), Layer.provideMerge(NodeServices.layer));

const fixture = Effect.fn("DesktopHistoryProjectionTest.fixture")(function* (
  library?: DesktopHistoryLibrary["Service"],
) {
  const config = yield* ServerConfig;
  const sink = yield* Sink.EventSinkV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const events: Contracts.OrchestrationV2DomainEvent[] = [];
  const controls = {
    allowed: true,
    internal: false,
    failCommit: false,
    afterRead: Effect.void,
    beforeBatch: Effect.void as Effect.Effect<
      void,
      Sink.EventSinkWriteError | Sink.EventSinkStreamError
    >,
  };
  const entry: Contracts.CodexDesktopHistoryEntry = {
    conversationId: "history-native",
    sourceId: "a".repeat(64),
    title: "Original",
    cwd: config.stateDir,
    archived: false,
    updatedAt: 1,
    fetchedAt: 1,
    status: "cached",
    error: null,
    membership: { kind: "none", projectId: null, projectTitle: null, source: "desktop-cache" },
  };
  const history: CodexHistory = {
    nativeThreadId: entry.conversationId,
    turnIds: ["done", "busy"],
    omittedItemTypes: [],
    messages: [
      {
        turnId: "done",
        itemId: "answer",
        role: "assistant",
        text: "saved answer",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        turnId: "busy",
        itemId: "stream",
        role: "assistant",
        text: "unconfirmed partial",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    canonical: {
      consistency: "observed-stable",
      thread: { id: entry.conversationId, createdAt: 1, turns: [] },
      turns: [
        { id: "done", status: "completed", items: [] },
        { id: "busy", status: "inProgress", items: [] },
      ],
      itemEntries: [],
    },
  };
  const project = {
    id: Contracts.ProjectId.make("workspace"),
    workspaceRoot: config.stateDir,
    archivedAt: null,
  } as Contracts.Project;
  const materialize = yield* makeDesktopHistoryProjector.pipe(
    Effect.provide(
      Layer.mergeAll(
        library
          ? Layer.succeed(DesktopHistoryLibrary, library)
          : Layer.mock(DesktopHistoryLibrary)({
              mayProject: (_sourceId, nativeId) =>
                Effect.sync(
                  () =>
                    controls.allowed && !(nativeId === entry.conversationId && controls.internal),
                ),
              withProjection: (effect) => effect,
              read: () => controls.afterRead.pipe(Effect.as(history)),
            }),
        Layer.mock(Projects.ProjectService)({
          getByWorkspaceRoot: () => Effect.succeedSome(project),
        }),
        Layer.succeed(Sink.EventSinkV2, {
          ...sink,
          write: (input) =>
            sink.write(input).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  events.push(...input.events);
                }),
              ),
            ),
          withProviderBatch: (effect) =>
            controls.beforeBatch.pipe(
              Effect.andThen(
                sink.withProviderBatch(
                  effect.pipe(
                    Effect.tap(() =>
                      controls.failCommit
                        ? Effect.fail(
                            new Sink.EventSinkWriteError({
                              eventCount: 0,
                              cause: "injected commit failure",
                            }),
                          )
                        : Effect.void,
                    ),
                  ),
                ),
              ),
            ),
        }),
        ThreadCommands.layer,
      ),
    ),
  );
  const threadId = Contracts.ThreadId.make(`codex-desktop:${entry.conversationId}`);
  const records = projections.getThreadRecords(threadId, ["messages", "providerThreads"]);
  return { entry, history, controls, materialize, threadId, records, sink, projections, events };
});

it.effect(
  "serializes actual library classification writes with projection commits while native reads stay outside the gate",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const home = `${config.stateDir}/classification-home`;
      yield* fs.makeDirectory(home);
      const readerEntered = yield* Deferred.make<void>();
      const readerRelease = yield* Deferred.make<void>();
      const readerReturned = yield* Deferred.make<void>();
      const projectionEntered = yield* Deferred.make<void>();
      const projectionRelease = yield* Deferred.make<void>();
      const titleEntered = yield* Deferred.make<void>();
      const titleRelease = yield* Deferred.make<void>();
      let pauseRead = false;
      let titleReads = 0;
      let pauseTitle = true;
      const library = Context.get(
        yield* Layer.build(
          HistoryLibrary.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(CodexSessionHistory, {
                  readTitle: () =>
                    Effect.gen(function* () {
                      titleReads++;
                      yield* Deferred.succeed(titleEntered, undefined);
                      if (pauseTitle) yield* Deferred.await(titleRelease);
                      return "Explicit user-owned title";
                    }),
                  discover: () =>
                    Effect.succeed([
                      {
                        thread: {
                          id: "history-native",
                          createdAt: 1,
                          turns: [],
                          cwd: home,
                          source: "vscode",
                        },
                        archived: false,
                      },
                    ]),
                  read: () =>
                    Effect.gen(function* () {
                      if (pauseRead) {
                        yield* Deferred.succeed(readerEntered, undefined);
                        yield* Deferred.await(readerRelease);
                        yield* Deferred.succeed(readerReturned, undefined);
                      }
                      return {
                        nativeThreadId: "history-native",
                        messages: [],
                        omittedItemTypes: [],
                        canonical: {
                          consistency: "observed-stable" as const,
                          thread: {
                            id: "history-native",
                            createdAt: 1,
                            turns: [],
                            cwd: home,
                            name: "Original",
                            source: "vscode",
                            ...(pauseRead ? { threadSource: "ambient_suggestions" } : {}),
                          },
                          turns: [],
                          itemEntries: [],
                        },
                      };
                    }),
                }),
                Settings.layerTest({
                  providerInstances: {
                    [Contracts.ProviderInstanceId.make("codex-desktop")]: {
                      driver: "codex",
                      enabled: true,
                      config: { setupMode: "existing", homePath: home },
                    },
                  },
                }),
                Layer.succeed(HostProcess.Environment, { CODEX_HOME: home }),
                Layer.succeed(ServerActivation, Effect.never),
              ),
            ),
          ),
        ),
        DesktopHistoryLibrary,
      );
      yield* library.refresh;
      const entry = (yield* library.list)[0]!;
      const f = yield* fixture(library);
      yield* f.materialize(entry);
      pauseRead = true;
      yield* TestClock.adjust("5 minutes");
      const refresh = yield* library.refresh.pipe(Effect.forkScoped);
      yield* Deferred.await(readerEntered);
      f.controls.beforeBatch = Deferred.succeed(projectionEntered, undefined).pipe(
        Effect.andThen(Deferred.await(projectionRelease)),
      );
      const projection = yield* f
        .materialize({ ...entry, title: "Accepted before classification", fetchedAt: 2 })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(projectionEntered);
      const title = yield* library
        .observeTitle(entry.conversationId, entry.sourceId, true)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(titleEntered);
      yield* Deferred.succeed(readerRelease, undefined);
      yield* Deferred.await(readerReturned);
      assert.isTrue(yield* library.mayProject(entry.sourceId, entry.conversationId));
      yield* Deferred.succeed(projectionRelease, undefined);
      yield* Fiber.join(projection);
      yield* Fiber.join(refresh);
      assert.deepEqual(yield* library.list, []);
      assert.isFalse(yield* library.mayProject(entry.sourceId, entry.conversationId));
      yield* Deferred.succeed(titleRelease, undefined);
      assert.isNull(yield* Fiber.join(title));
      assert.isNull(yield* library.observeTitle(entry.conversationId, entry.sourceId, true));
      assert.equal(titleReads, 1);
      pauseTitle = false;
      const explicit = yield* library.observeTitle(entry.conversationId, entry.sourceId);
      assert.isNotNull(explicit);
      assert.isTrue(yield* library.isCurrentTitle(explicit!));
      assert.isFalse(yield* library.isCurrentTitle(explicit!, true));
      const preserved = yield* f.records;
      assert.equal(preserved.thread.title, "Accepted before classification");
      f.controls.beforeBatch = Effect.void;
      yield* f.materialize({ ...entry, title: "Rejected internal update", fetchedAt: 3 });
      assert.deepEqual(yield* f.records, preserved);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "projects completed history once and preserves title intent and execution workspace when Desktop membership moves",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.materialize(f.entry);
      const before = yield* f.records;
      const snapshot = yield* f.projections.getThreadProjection(f.threadId);
      yield* TestClock.adjust("1 minute");
      const restarted = yield* fixture();
      yield* restarted.materialize(restarted.entry);
      assert.deepEqual((yield* f.records).thread.updatedAt, before.thread.updatedAt);
      assert.deepEqual(
        restarted.events.reduce(Projections.applyToProjection, snapshot).thread.updatedAt,
        before.thread.updatedAt,
      );
      assert.deepEqual(
        before.messages.map((message) => message.text),
        ["saved answer"],
      );
      const renamed = {
        ...before.thread,
        title: "Local title",
        ...queueSharedTitle(before.thread, "Local title", "manual"),
      };
      const confirmed = {
        ...renamed,
        codexTitleSync: { ...renamed.codexTitleSync!, status: "confirmed" as const },
      };
      yield* f.sink.write({
        events: [
          {
            id: Contracts.EventId.make("local-rename"),
            type: "thread.metadata-updated",
            threadId: f.threadId,
            occurredAt: yield* DateTime.now,
            payload: confirmed,
          },
        ],
      });
      const assigned = {
        ...f.entry,
        fetchedAt: 2,
        title: "Stale disk title",
        membership: {
          kind: "assigned" as const,
          projectId: "desktop-project",
          projectTitle: "Desktop project",
          source: "native" as const,
        },
      };
      yield* f.materialize(assigned);
      const after = yield* f.records;
      assert.equal(after.thread.title, "Local title");
      assert.equal(after.thread.projectId, before.thread.projectId);
      assert.equal(after.thread.codexDesktopHistory?.membership.projectId, "desktop-project");
      assert.deepEqual(after.messages, before.messages);
      yield* f.materialize({ ...f.entry, fetchedAt: 3 });
      assert.equal((yield* f.records).thread.codexDesktopHistory?.membership.kind, "none");
      const local = (yield* f.records).thread;
      yield* f.sink.write({
        events: [
          {
            id: Contracts.EventId.make("confirmed-title-baseline"),
            type: "thread.metadata-updated",
            threadId: f.threadId,
            occurredAt: yield* DateTime.now,
            payload: {
              ...local,
              ...observeSharedTitle(local, "Local title", { epoch: "owner", revision: 1 }),
            },
          },
        ],
      });
      const canonical = (name: string, revision: number) => {
        Object.assign(f.history.canonical!.thread, { name });
        return {
          ...f.entry,
          fetchedAt: revision + 3,
          title: "Untrusted preview fallback",
          canonicalTitle: {
            cacheEpoch: "cache",
            revision,
            snapshot: String(revision).repeat(64),
            name,
          },
        };
      };
      yield* f.materialize(canonical("Local title", 1));
      yield* f.materialize(canonical("New persisted name", 2));
      const adopted = (yield* f.records).thread;
      assert.equal(adopted.title, "New persisted name");
      assert.equal(adopted.codexTitleSync?.status, "pending");
      assert.equal(adopted.codexTitleSync?.source, "saved");
      assert.equal(adopted.codexTitleSync?.ownerTitle, "Local title");
      assert.isNull(adopted.titleRegeneration);
      yield* f.materialize(canonical("Local title", 1));
      assert.equal((yield* f.records).thread.title, "New persisted name");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "advances for completed native activity while preserving newer manual actions and older backfill",
  () =>
    Effect.gen(function* () {
      const start = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-02T00:00:00Z"));
      yield* TestClock.setTime(start);
      const f = yield* fixture();
      yield* f.materialize(f.entry);
      assert.deepEqual(
        (yield* f.records).thread.updatedAt,
        DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
      );
      const at = (minutes: number) => DateTime.makeUnsafe(start + minutes * 60_000);
      const append = (id: string, minutes: number, text = true) => {
        Object.assign(f.history, {
          turnIds: [...f.history.turnIds!, id],
          messages: [
            ...f.history.messages,
            ...(text
              ? [
                  {
                    turnId: id,
                    itemId: id,
                    role: "assistant" as const,
                    text: id,
                    createdAt: DateTime.formatIso(at(minutes)),
                  },
                ]
              : []),
          ],
          canonical: {
            ...f.history.canonical!,
            turns: [
              ...f.history.canonical!.turns,
              {
                id,
                status: "completed",
                startedAt: (start + minutes * 60_000) / 1_000,
                completedAt: (start + (minutes + 1) * 60_000) / 1_000,
                items: [],
              },
            ],
          },
        });
      };
      yield* TestClock.adjust("5 minutes");
      append("new", 2);
      yield* f.materialize({ ...f.entry, fetchedAt: 2 });
      assert.deepEqual((yield* f.records).thread.updatedAt, at(3));
      const current = (yield* f.records).thread;
      yield* f.sink.write({
        events: [
          {
            id: Contracts.EventId.make("manual-activity"),
            type: "thread.metadata-updated",
            threadId: f.threadId,
            occurredAt: at(5),
            payload: {
              ...current,
              title: "Manual",
              ...queueSharedTitle(current, "Manual", "manual"),
              updatedAt: at(5),
            },
          },
        ],
      });
      append("old-backfill", 0);
      yield* TestClock.adjust("5 minutes");
      yield* f.materialize({ ...f.entry, fetchedAt: 3 });
      assert.deepEqual((yield* f.records).thread.updatedAt, at(5));
      append("tool-only", 6, false);
      yield* f.materialize({ ...f.entry, fetchedAt: 4 });
      assert.deepEqual((yield* f.records).thread.updatedAt, at(7));
      Object.assign(f.history.canonical!.turns[1]!, { startedAt: (start + 100 * 60_000) / 1_000 });
      yield* f.materialize({ ...f.entry, fetchedAt: 5 });
      assert.deepEqual((yield* f.records).thread.updatedAt, at(7));
      const latest = (yield* f.records).thread;
      f.controls.beforeBatch = f.sink
        .write({
          events: [
            {
              id: Contracts.EventId.make("concurrent-manual-activity"),
              type: "thread.metadata-updated",
              threadId: f.threadId,
              occurredAt: at(8),
              payload: { ...latest, updatedAt: at(8) },
            },
          ],
        })
        .pipe(Effect.asVoid);
      yield* f.materialize({ ...f.entry, fetchedAt: 6 });
      assert.deepEqual((yield* f.records).thread.updatedAt, at(8));
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps saved user timestamps through backfill and reordering without manufacturing missing activity",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-02T00:00:00Z")));
      const f = yield* fixture();
      const createdAt = DateTime.makeUnsafe(1_000);
      Object.assign(f.history, {
        messages: [
          {
            turnId: "done",
            itemId: "unknown-time",
            role: "assistant",
            text: "unknown time",
            createdAt: DateTime.formatIso(createdAt),
          },
        ],
      });
      Object.assign(f.history.canonical!.thread, { updatedAt: 1_767_312_000 });
      yield* f.materialize(f.entry);
      assert.deepEqual((yield* f.records).thread.updatedAt, createdAt);
      const userAt = "2026-01-01T00:10:00.000Z";
      const user = {
        turnId: "done",
        itemId: "user",
        role: "user" as const,
        text: "saved user",
        createdAt: userAt,
      };
      Object.assign(f.history, { messages: [...f.history.messages, user] });
      yield* f.materialize({ ...f.entry, fetchedAt: 2 });
      const before = yield* f.records;
      const savedUser = before.messages.find((message) => message.role === "user")!;
      assert.deepEqual(savedUser.createdAt, DateTime.makeUnsafe(userAt));
      assert.deepEqual(savedUser.updatedAt, savedUser.createdAt);
      const shell = (yield* f.projections.getThreadShell(f.threadId))!;
      assert.deepEqual(shell.latestUserMessageAt, savedUser.createdAt);
      assert.deepEqual(shell.latestUserAuthoredMessageAt, savedUser.createdAt);
      const beforeItems = (yield* f.projections.getThreadProjection(f.threadId)).turnItems;
      const userItem = beforeItems.find((item) => item.type === "user_message")!;

      // A complete older backfill moves the existing user's canonical position.
      Object.assign(f.history, {
        messages: [
          {
            ...user,
            itemId: "older-user",
            text: "older user",
            createdAt: "2026-01-01T00:05:00.000Z",
          },
          ...f.history.messages,
        ],
      });
      yield* TestClock.adjust("10 minutes");
      yield* f.materialize({ ...f.entry, fetchedAt: 3 });
      const reordered = yield* f.records;
      assert.deepEqual(reordered.thread.updatedAt, before.thread.updatedAt);
      assert.deepEqual(
        reordered.messages.find((message) => message.id === savedUser.id),
        savedUser,
      );
      const afterItem = (yield* f.projections.getThreadProjection(f.threadId)).turnItems.find(
        (item) => item.id === userItem.id,
      )!;
      assert.notDeepEqual(afterItem.nativeHistoryPosition, userItem.nativeHistoryPosition);
      assert.deepEqual(afterItem.updatedAt, userItem.updatedAt);
      assert.deepEqual(
        (yield* f.projections.getThreadShell(f.threadId))!.latestUserMessageAt,
        shell.latestUserMessageAt,
      );
      assert.deepEqual(
        (yield* f.projections.getThreadShell(f.threadId))!.latestUserAuthoredMessageAt,
        shell.latestUserAuthoredMessageAt,
      );

      Object.assign(f.history, {
        messages: [
          ...f.history.messages,
          {
            ...user,
            role: "assistant",
            itemId: "new-answer",
            text: "new answer",
            createdAt: "2026-01-01T00:12:00.000Z",
          },
        ],
      });
      yield* f.materialize({ ...f.entry, fetchedAt: 4 });
      assert.deepEqual(
        (yield* f.records).thread.updatedAt,
        DateTime.makeUnsafe("2026-01-01T00:12:00Z"),
      );
      assert.deepEqual(
        (yield* f.projections.getThreadShell(f.threadId))!.latestUserMessageAt,
        savedUser.createdAt,
      );
      const newUserAt = DateTime.makeUnsafe("2026-01-01T00:14:00Z");
      Object.assign(f.history, {
        messages: [
          ...f.history.messages,
          {
            ...user,
            itemId: "new-user",
            text: "new user",
            createdAt: DateTime.formatIso(newUserAt),
          },
        ],
      });
      yield* f.materialize({ ...f.entry, fetchedAt: 5 });
      assert.deepEqual((yield* f.records).thread.updatedAt, newUserAt);
      assert.deepEqual(
        (yield* f.projections.getThreadShell(f.threadId))!.latestUserMessageAt,
        newUserAt,
      );
      assert.deepEqual(
        (yield* f.projections.getThreadShell(f.threadId))!.latestUserAuthoredMessageAt,
        newUserAt,
      );

      Object.assign(f.history, {
        messages: [
          ...f.history.messages,
          { ...user, itemId: "missing-time", createdAt: DateTime.formatIso(createdAt) },
        ],
      });
      Object.assign(f.history.canonical!, {
        turns: [
          ...f.history.canonical!.turns,
          { id: "tool-only-unknown", status: "completed", items: [] },
        ],
      });
      Object.assign(f.history.canonical!.thread, { updatedAt: 1_800_000_000, name: "Renamed" });
      yield* f.materialize({ ...f.entry, fetchedAt: 6 });
      assert.deepEqual((yield* f.records).thread.updatedAt, newUserAt);
      assert.deepEqual(
        (yield* f.projections.getThreadShell(f.threadId))!.latestUserMessageAt,
        newUserAt,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "discards a read when Share is disabled before creation, rejects another source and retries a rolled-back commit",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.controls.afterRead = Effect.sync(() => {
        f.controls.allowed = false;
      });
      yield* f.materialize(f.entry);
      assert.isTrue(Exit.isFailure(yield* f.records.pipe(Effect.exit)));
      f.controls.afterRead = Effect.void;
      f.controls.allowed = true;
      f.controls.afterRead = Effect.sync(() => {
        f.controls.internal = true;
      });
      yield* f.materialize(f.entry);
      assert.isTrue(Exit.isFailure(yield* f.records.pipe(Effect.exit)));
      f.controls.afterRead = Effect.void;
      f.controls.internal = false;
      yield* f.materialize(f.entry);
      const before = yield* f.records;
      f.controls.beforeBatch = Effect.sync(() => {
        f.controls.internal = true;
      });
      yield* f.materialize({ ...f.entry, title: "Internal late metadata", fetchedAt: 2 });
      assert.deepEqual(yield* f.records, before);
      f.controls.beforeBatch = Effect.void;
      f.controls.internal = false;
      yield* f.materialize({
        ...f.entry,
        sourceId: "b".repeat(64),
        title: "Other account",
        fetchedAt: 2,
      });
      assert.deepEqual((yield* f.records).thread, before.thread);
      f.controls.failCommit = true;
      const updated = { ...f.entry, title: "New saved title", fetchedAt: 2 };
      assert.isTrue(Exit.isFailure(yield* f.materialize(updated).pipe(Effect.exit)));
      assert.equal((yield* f.records).thread.title, "Original");
      f.controls.failCommit = false;
      yield* f.materialize(updated);
      assert.equal((yield* f.records).thread.title, "New saved title");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "rechecks the owner inside the commit boundary and leaves a concurrent native handoff intact",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.materialize(f.entry);
      const before = yield* f.records;
      f.controls.beforeBatch = f.sink
        .write({
          events: [
            {
              id: Contracts.EventId.make("native-handoff"),
              type: "thread.metadata-updated",
              threadId: f.threadId,
              occurredAt: yield* DateTime.now,
              payload: { ...before.thread, codexSharedOwner: "native" },
            },
          ],
        })
        .pipe(Effect.asVoid);
      yield* f.materialize({ ...f.entry, fetchedAt: 2, title: "Late saved title" });
      const after = yield* f.records;
      assert.equal(after.thread.codexSharedOwner, "native");
      assert.equal(after.thread.title, "Original");
      assert.deepEqual(after.messages, before.messages);
    }).pipe(Effect.provide(layer)),
);
