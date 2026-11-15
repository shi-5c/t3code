import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Contracts from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { DesktopHistoryLibrary } from "./DesktopHistoryLibrary.ts";
import { desktopHistorySourceId } from "./DesktopHistoryStore.ts";
import { ServerConfig } from "../config.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommands from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as CodexSessionHistory from "../project/CodexSessionHistory.ts";
import { CodexDesktop, type DesktopCanonicalSnapshot } from "./CodexDesktop.ts";
import { DesktopSyncPersistence } from "./DesktopSyncPersistence.ts";
import { SharedDesktopStore } from "./SharedDesktopStore.ts";
import * as SharedThreads from "./SharedDesktopThreads.ts";
import { projectDesktopConversation } from "./projection.ts";
import { sharedDesktopEvents } from "./sharedProjection.ts";
import { desktopResponseKey } from "./requests.ts";
import { queueSharedTitle, observeNativeTitle } from "./sharedTitle.ts";
import {
  sharedNativeHandoffEvents,
  sharedNativeOwner,
  handoffFields,
} from "./sharedNativeHandoff.ts";

const decodeThread = Schema.decodeEffect(Contracts.OrchestrationV2AppThread);
const decodeEvent = Schema.decodeEffect(Contracts.OrchestrationV2DomainEvent);
const layerTest = Layer.mergeAll(
  RuntimeLayer.layerEventSink,
  Projections.layer,
  ServerConfig.layerTest("/workspace", { prefix: "t3-desktop-binding-" }),
).pipe(Layer.provide(Persistence.layerMemory), Layer.provideMerge(NodeServices.layer));
const fixture = Effect.fn("SharedDesktopThreadsTest.fixture")(function* (
  native = false,
  nativeInstanceId = "codex",
  unresolvedHome = false,
) {
  const now = yield* DateTime.now;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const thread = yield* decodeThread({
    id: native ? "original-t3-thread" : "codex-desktop:native",
    threadType: "codex-shared",
    ...(native ? { codexSharedOwner: "native" } : {}),
    projectId: "project",
    title: "Shared",
    providerInstanceId: native ? nativeInstanceId : "codex-desktop",
    modelSelection: {
      instanceId: native ? nativeInstanceId : "codex-desktop",
      model: "test-model",
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: native ? "original-provider-thread" : "desktop-provider-thread:native",
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: "codex-desktop:native",
    },
    forkedFrom: null,
    createdBy: "system",
    creationSource: "server",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
  });
  const store = yield* Effect.acquireRelease(
    Effect.sync(() => new SharedDesktopStore(":memory:")),
    (store) => Effect.sync(() => store.close()),
  );
  if (!native)
    store.bind({
      threadId: thread.id,
      conversationId: "native",
      projectId: "project",
      instanceId: "codex-desktop",
    });
  const sink = yield* Sink.EventSinkV2;
  const projections = yield* Projections.ProjectionStoreV2;
  yield* sink.write({
    events: sharedDesktopEvents({
      thread,
      nativeId: "native",
      state: { turns: [] },
      epoch: "epoch",
      revision: 0,
      now,
    }).map((event) =>
      native && event.type === "provider-thread.updated"
        ? {
            ...event,
            payload: {
              ...event.payload,
              id: thread.activeProviderThreadId!,
              nativeMetadata: {
                codexShared: true,
                codexSharedRelease: { state: "ready", generation: "release-1", nativeId: "native" },
              },
            },
          }
        : native && event.type === "thread.metadata-updated"
          ? { ...event, payload: thread }
          : event,
    ),
  });
  const queue = yield* Queue.unbounded<DesktopCanonicalSnapshot>();
  const processed = yield* Queue.unbounded<number>();
  const changed = yield* PubSub.unbounded<void>();
  const committed = yield* Deferred.make<void>();
  const writes = yield* Queue.unbounded<void>();
  const history: { value: CodexSessionHistory.CodexHistory } = {
    value: { nativeThreadId: "native", turnIds: [], messages: [], omittedItemTypes: [] },
  };
  const failures = { commit: false };
  const controls: {
    home: string;
    workspace: string;
    beforeSourceCheck: Effect.Effect<void>;
    beforeRead: Effect.Effect<void>;
    beforeHandoffCommit: Effect.Effect<void>;
    independentHandoffCommit: boolean;
    afterProjectionRead: Effect.Effect<void>;
    historyEntries: ReadonlyArray<Contracts.CodexDesktopHistoryEntry>;
  } = {
    home: config.stateDir,
    workspace: "/workspace",
    beforeSourceCheck: Effect.void,
    beforeRead: Effect.void,
    beforeHandoffCommit: Effect.void,
    independentHandoffCommit: false,
    afterProjectionRead: Effect.void,
    historyEntries: [],
  };
  const serviceLayer = SharedThreads.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CodexDesktop)({
          home: Effect.sync(() => controls.home),
          watchCanonical: () =>
            Stream.fromQueue(queue).pipe(
              Stream.flatMap((snapshot) =>
                Stream.concat(
                  Stream.make(snapshot),
                  Stream.fromEffect(Queue.offer(processed, snapshot.view.revision)).pipe(
                    Stream.drain,
                  ),
                ),
              ),
            ),
        }),
        Layer.succeed(DesktopSyncPersistence, { get: Effect.succeed(store) }),
        Layer.mock(DesktopHistoryLibrary)({
          list: Effect.sync(() => controls.historyEntries),
          mayProject: () => Effect.succeed(true),
        }),
        Layer.succeed(Projections.ProjectionStoreV2, {
          ...projections,
          getThreadRecords: (id, fields) =>
            projections
              .getThreadRecords(id, fields)
              // Revision 2 introduces a new turn; empty revision 1 replays cannot consume this barrier.
              .pipe(
                Effect.tap(() =>
                  fields.length === 3 &&
                  fields.some((field) => field === "runs") &&
                  fields.some((field) => field === "providerTurns")
                    ? controls.afterProjectionRead
                    : Effect.void,
                ),
              ),
        }),
        Layer.mock(Sink.EventSinkV2)({
          // The CAS race case injects a separately committed intent immediately before the
          // final atomic write. Other cases retain the production batch transaction.
          withProviderBatch: (effect) =>
            controls.independentHandoffCommit ? effect : sink.withProviderBatch(effect),
          writeIfProviderThreadUnchanged: (input) =>
            failures.commit
              ? Effect.fail(
                  new Sink.EventSinkWriteError({
                    eventCount: input.events.length,
                    cause: "injected handoff failure",
                  }),
                )
              : controls.beforeHandoffCommit.pipe(
                  Effect.andThen(sink.writeIfProviderThreadUnchanged(input)),
                ),
          write: (input) =>
            sink.write(input).pipe(
              Effect.tap(() => Queue.offer(writes, undefined)),
              Effect.tap(() =>
                input.events.some((event) => event.type === "run.updated")
                  ? Deferred.succeed(committed, undefined)
                  : Effect.void,
              ),
            ),
        }),
        Layer.mock(Projects.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              id: thread.projectId,
              workspaceRoot: controls.workspace,
              archivedAt: null,
            } as Contracts.Project),
        }),
        ThreadCommands.layer,
        Layer.succeed(CodexSessionHistory.CodexSessionHistory, {
          read: () => controls.beforeRead.pipe(Effect.andThen(Effect.sync(() => history.value))),
        }),
        Settings.layerTest({
          providerInstances: {
            [Contracts.ProviderInstanceId.make("codex")]: {
              driver: "codex",
              enabled: true,
              ...(unresolvedHome
                ? {
                    environment: [
                      {
                        name: "CODEX_HOME",
                        value: {
                          provider: Contracts.SecretProviderId.make("fixture"),
                          reference: "home-reference",
                        },
                        sensitive: true,
                      },
                    ],
                  }
                : {}),
              config: { setupMode: "existing", homePath: config.stateDir },
            },
            [Contracts.ProviderInstanceId.make("codex-desktop")]: {
              driver: "codex",
              displayName: "Desktop",
              enabled: true,
              config: { setupMode: "existing", homePath: config.stateDir },
            },
          },
        }),
        // The importer only checks instance/session existence; these unrelated runtimes are never invoked.
        Layer.mock(Instances.ProviderInstanceRegistry)({
          subscribeChanges: PubSub.subscribe(changed),
          getInstance: () => Effect.succeed({} as ProviderInstance),
        }),
        Layer.mock(Sessions.ProviderSessionManagerV2)({
          get: () =>
            Effect.succeedSome({
              providerSessionId: Contracts.ProviderSessionId.make("desktop-session:native"),
            } as ProviderAdapterV2SessionRuntime),
        }),
        Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          realPath: (value) => controls.beforeSourceCheck.pipe(Effect.andThen(fs.realPath(value))),
        }),
        Layer.succeed(Path.Path, path),
        Layer.succeed(ServerConfig, config),
      ),
    ),
  );
  let bindingScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(bindingScope, Exit.void));
  const serviceContext = yield* Layer.buildWithScope(serviceLayer, bindingScope);
  let service = Context.get(serviceContext, SharedThreads.SharedDesktopThreads);
  const restart = Effect.gen(function* () {
    yield* Scope.close(bindingScope, Exit.void);
    bindingScope = yield* Scope.make();
    service = Context.get(
      yield* Layer.buildWithScope(Layer.fresh(serviceLayer), bindingScope),
      SharedThreads.SharedDesktopThreads,
    );
    if (!native) yield* service.bind("native");
  });
  if (!native) yield* service.bind("native");
  const snapshot = (
    ids: string[],
    complete: boolean,
    revision: number,
  ): DesktopCanonicalSnapshot => {
    const state = {
      title: "Shared",
      cwd: "/workspace",
      latestModel: "test-model",
      threadRuntimeStatus: { type: "idle" },
      turnHistory: {
        history: {
          isComplete: complete,
          islands: [{ entries: ids.map((key) => ({ key })) }],
          entitiesByKey: Object.fromEntries(
            ids.map((id) => [
              id,
              {
                turnId: id,
                status: "completed",
                items: [{ id: `assistant-${id}`, type: "agentMessage", text: `reply-${id}` }],
              },
            ]),
          ),
        },
      },
    };
    return {
      view: {
        conversationId: "native",
        status: "ready",
        detail: "Connected",
        epoch: "epoch",
        revision,
        ...projectDesktopConversation(state),
      },
      state,
    };
  };
  return {
    store,
    queue,
    committed,
    snapshot,
    projections,
    thread,
    processed,
    sink,
    writes,
    restart,
    history,
    failures,
    controls,
    awaitProcessed: (revision: number) =>
      Effect.gen(function* () {
        while ((yield* Queue.take(processed)) !== revision) {}
      }),
    awaitProjected: (revision: number, epoch = "epoch") =>
      sink.stream({ threadId: thread.id, afterSequence: 0 }).pipe(
        Stream.filter((stored) =>
          String(stored.event.id).startsWith(`desktop-event:${epoch}:${revision}:`),
        ),
        Stream.take(1),
        Stream.runDrain,
      ),
    get service() {
      return service;
    },
  };
});

it.effect(
  "retains pending permission details and turn/session choices across a binding restart",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const original = f.snapshot(["permission-turn"], true, 1);
      const permissions = {
        fileSystem: { read: ["C:/fixture/input"], write: ["C:/fixture/output"] },
        network: { enabled: true },
      };
      const state = {
        ...original.state,
        requests: [
          {
            id: 42,
            method: "item/permissions/requestApproval",
            params: { turnId: "permission-turn", itemId: "permission-item", permissions },
          },
        ],
      };
      yield* Queue.offer(f.queue, { ...original, state });
      yield* f.awaitProjected(1);
      const before = yield* f.projections.getThreadProjection(f.thread.id);
      const pending = before.runtimeRequests.find((request) => request.status === "pending");
      const card = before.turnItems.find((item) => item.type === "approval_request");
      assert.equal(pending?.responseCapability.type, "live");
      assert.equal(card?.type, "approval_request");
      if (card?.type !== "approval_request") return yield* Effect.die("Missing permission card");
      assert.include(card.prompt!, JSON.stringify(permissions, null, 2));
      assert.includeDeepMembers(
        [...card.options!],
        [
          { decision: "accept", label: "Allow for this turn" },
          { decision: "acceptForSession", label: "Allow for this session" },
        ],
      );
      yield* f.restart;
      const reloaded = yield* f.projections.getThreadProjection(f.thread.id);
      assert.deepEqual(
        reloaded.turnItems.find((item) => item.id === card.id),
        card,
      );
      assert.deepEqual(
        reloaded.runtimeRequests.find((request) => request.id === pending!.id),
        pending,
      );
      yield* Queue.offer(f.queue, { ...original, view: { ...original.view, revision: 2 }, state });
      yield* f.awaitProcessed(2);
      const reconnected = yield* f.projections.getThreadProjection(f.thread.id);
      assert.deepEqual(
        reconnected.turnItems.find((item) => item.id === card.id),
        card,
      );
      assert.lengthOf(
        reconnected.runtimeRequests.filter((request) => request.status === "pending"),
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("persists the live owner permission mode after handoff and later changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    for (const [revision, approvalPolicy, type, expected] of [
      [1, "never", "dangerFullAccess", "full-access"],
      [2, "untrusted", "readOnly", "approval-required"],
    ] as const) {
      const snapshot = f.snapshot([], true, revision);
      yield* Queue.offer(f.queue, {
        ...snapshot,
        state: {
          ...snapshot.state,
          currentPermissions: { approvalPolicy, sandboxPolicy: { type } },
        },
      });
      yield* f.awaitProjected(revision);
      const current = yield* f.projections.getThreadRecords(f.thread.id, []);
      assert.equal(current.thread.runtimeMode, expected);
    }
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect.each(["connect", "restart", "manual-during-read", "manual-at-commit"] as const)(
  "connects a saved title observation while protecting new local intent (%s)",
  (condition) =>
    Effect.gen(function* () {
      const f = yield* fixture(true, "codex-desktop");
      const before = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
      let title = {
        ...before.thread,
        title: "A",
        ...queueSharedTitle(before.thread, "A", "generated"),
      };
      const read = (name: string, revision: number) => ({
        sourceId: "source",
        nativeId: "native",
        epoch: "metadata",
        name,
        revision,
      });
      title = { ...title, ...observeNativeTitle(title, read("A", 1), true, true, true) };
      title = { ...title, ...observeNativeTitle(title, read("B", 2), true, true, true) };
      assert.equal(title.codexTitleSync?.source, "saved");
      const now = yield* DateTime.now;
      yield* f.sink.write({
        events: [
          yield* decodeEvent({
            id: "observed-B",
            type: "thread.metadata-updated",
            threadId: f.thread.id,
            occurredAt: now,
            payload: title,
          }),
          yield* decodeEvent({
            id: "native-saved-A",
            type: "provider-thread.updated",
            threadId: f.thread.id,
            occurredAt: now,
            payload: {
              ...before.providerThreads[0]!,
              nativeMetadata: {
                ...before.providerThreads[0]!.nativeMetadata,
                codexNativeTitle: {
                  status: "saved",
                  desiredTitle: "A",
                  observedTitle: "A",
                  version: 1,
                },
              },
            },
          }),
        ],
      });
      const manual = Effect.gen(function* () {
        f.controls.beforeHandoffCommit = Effect.void;
        const current = yield* f.projections.getThreadRecords(f.thread.id, []);
        yield* f.sink.write({
          events: [
            yield* decodeEvent({
              id: "manual-C",
              type: "thread.metadata-updated",
              threadId: f.thread.id,
              occurredAt: yield* DateTime.now,
              payload: {
                ...current.thread,
                title: "C",
                ...queueSharedTitle(current.thread, "C", "manual"),
              },
            }),
          ],
        });
      }).pipe(Effect.orDie);
      if (condition === "restart") yield* f.restart;
      if (condition === "manual-during-read") f.controls.beforeRead = manual;
      if (condition === "manual-at-commit") f.controls.beforeHandoffCommit = manual;
      if (condition === "manual-at-commit") f.controls.independentHandoffCommit = true;
      const snapshot = f.snapshot([], true, 1);
      yield* Queue.offer(f.queue, {
        ...snapshot,
        view: { ...snapshot.view, title: "A" },
        state: { ...snapshot.state, title: "A" },
      });
      const result = yield* f.service.attachExisting(f.thread.id, "native").pipe(Effect.exit);
      const current = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
      if (condition.startsWith("manual")) {
        assert.isTrue(Exit.isFailure(result));
        assert.equal(current.thread.title, "C");
        assert.equal(current.thread.codexTitleSync?.source, "manual");
        assert.equal(current.thread.codexSharedOwner, "native");
      } else {
        assert.isTrue(Exit.isSuccess(result));
        assert.equal(current.thread.title, "B");
        assert.equal(current.thread.codexSharedOwner, "desktop");
        assert.equal(current.thread.codexTitleSync?.status, "pending");
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect.each(["codex", "codex-desktop"])(
  "attaches the same T3 thread from %s, retains native run associations and deduplicates history after restart",
  (nativeInstanceId) =>
    Effect.gen(function* () {
      const f = yield* fixture(true, nativeInstanceId);
      const before = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
      const owner = before.providerThreads[0]!;
      const now = yield* DateTime.now;
      const a = f.snapshot(["A"], true, 1);
      yield* f.sink.write({
        events: sharedDesktopEvents({
          thread: f.thread,
          providerThread: owner,
          nativeId: "native",
          state: a.state!,
          epoch: "native",
          revision: 1,
          now,
        }),
      });
      const original = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
      f.history.value = {
        nativeThreadId: "native",
        turnIds: ["A", "B"],
        omittedItemTypes: [],
        messages: ["A", "B"].map((id) => ({
          turnId: id,
          itemId: `assistant-${id}`,
          role: "assistant",
          text: `reply-${id}`,
          createdAt: DateTime.formatIso(now),
        })),
      };
      yield* Queue.offer(f.queue, f.snapshot(["A", "B"], true, 2));
      assert.deepEqual(yield* f.service.attachExisting(f.thread.id, "native"), {
        threadId: f.thread.id,
        uncertain: [],
      });
      const attached = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
      assert.equal(attached.thread.id, original.thread.id);
      assert.equal(attached.thread.providerInstanceId, "codex-desktop");
      assert.equal(attached.thread.codexSharedOwner, "desktop");
      assert.equal(attached.providerThreads.length, 2);
      assert.deepEqual(attached.runs, original.runs);
      assert.deepEqual(attached.providerTurns, original.providerTurns);
      assert.deepEqual(
        attached.providerThreads.find((value) => value.id === owner.id),
        original.providerThreads.find((value) => value.id === owner.id),
      );
      assert.equal(attached.messages.filter((value) => value.text === "reply-A").length, 1);
      assert.equal(attached.messages.filter((value) => value.text === "reply-B").length, 1);
      // Repeated attach is idempotent and consumes no owner snapshot or send request.
      yield* f.service.attachExisting(f.thread.id, "native");
      const changedEffort = f.snapshot(["A", "B", "C"], true, 3);
      yield* Queue.offer(f.queue, {
        ...changedEffort,
        state: { ...changedEffort.state, latestReasoningEffort: "medium" },
      });
      yield* f.awaitProjected(3);
      let followed = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
      assert.deepEqual(
        followed.providerThreads.find((p) => p.id === followed.thread.activeProviderThreadId)
          ?.nativeMetadata?.modelSelection?.options,
        [{ id: "reasoningEffort", value: "medium" }],
      );
      assert.deepEqual(followed.thread.modelSelection.options, [
        { id: "reasoningEffort", value: "medium" },
      ]);
      assert.deepEqual(
        followed.messages
          .filter((value) => value.role === "assistant")
          .map((value) => value.text)
          .sort(),
        ["reply-A", "reply-B", "reply-C"],
      );
      assert.deepEqual(
        followed.runs.find((run) => run.id === original.runs[0]!.id),
        original.runs[0],
      );
      const newRun = followed.runs.find((run) => run.id === "desktop-run:C")!;
      assert.equal(newRun.providerThreadId, followed.thread.activeProviderThreadId);
      yield* f.sink.write({
        events: [
          yield* decodeEvent({
            id: "local-unsent-model-choice",
            type: "thread.metadata-updated",
            threadId: f.thread.id,
            occurredAt: now,
            payload: {
              ...followed.thread,
              modelSelection: {
                ...followed.thread.modelSelection,
                options: [{ id: "reasoningEffort", value: "high" }],
              },
            },
          }),
        ],
      });
      const unchangedOwner = f.snapshot(["A", "B", "C"], true, 4);
      yield* Queue.offer(f.queue, {
        ...unchangedOwner,
        state: {
          ...unchangedOwner.state,
          title: "owner-options-rev4",
          latestReasoningEffort: "medium",
        },
      });
      yield* f.awaitProjected(4);
      assert.deepEqual(
        (yield* f.projections.getThreadRecords(f.thread.id, handoffFields)).thread.modelSelection
          .options,
        [{ id: "reasoningEffort", value: "high" }],
      );
      yield* f.restart;
      yield* f.service.attachExisting(f.thread.id, "native");
      const afterRestart = f.snapshot(["A", "B", "C"], true, 5);
      yield* Queue.offer(f.queue, {
        ...afterRestart,
        state: { ...afterRestart.state, latestReasoningEffort: "medium" },
      });
      yield* f.awaitProjected(5);
      assert.deepEqual(
        (yield* f.projections.getThreadRecords(f.thread.id, handoffFields)).thread.modelSelection
          .options,
        [{ id: "reasoningEffort", value: "high" }],
      );
      const tierChanged = f.snapshot(["A", "B", "C"], true, 6);
      yield* Queue.offer(f.queue, {
        ...tierChanged,
        state: {
          ...tierChanged.state,
          latestReasoningEffort: "medium",
          latestThreadSettings: { serviceTier: "default" },
        },
      });
      yield* f.awaitProjected(6);
      assert.deepEqual(
        (yield* f.projections.getThreadRecords(f.thread.id, handoffFields)).thread.modelSelection
          .options,
        [
          { id: "reasoningEffort", value: "medium" },
          { id: "serviceTier", value: "default" },
        ],
      );
      const newEffort = f.snapshot(["A", "B", "C"], true, 7);
      yield* Queue.offer(f.queue, {
        ...newEffort,
        state: { ...newEffort.state, latestReasoningEffort: "low" },
      });
      yield* f.awaitProjected(7);
      assert.deepEqual(
        (yield* f.projections.getThreadRecords(f.thread.id, handoffFields)).thread.modelSelection
          .options,
        [
          { id: "reasoningEffort", value: "low" },
          { id: "serviceTier", value: "default" },
        ],
      );
      yield* f.restart;
      yield* f.service.attachExisting(f.thread.id, "native");
      yield* Queue.offer(f.queue, f.snapshot(["A", "B", "C"], true, 8));
      yield* f.awaitProjected(8);
      followed = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
      assert.equal(followed.messages.filter((value) => value.role === "assistant").length, 3);
      assert.deepEqual(
        followed.providerTurns.find((turn) => turn.id === original.providerTurns[0]!.id),
        original.providerTurns[0],
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect(
  "preserves provider fields and a local model choice committed after reading an owner snapshot",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = f.snapshot([], true, 1);
      yield* Queue.offer(f.queue, {
        ...first,
        state: { ...first.state, latestReasoningEffort: "medium" },
      });
      yield* f.awaitProjected(1);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.controls.afterProjectionRead = Effect.gen(function* () {
        f.controls.afterProjectionRead = Effect.void;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
      });
      const next = f.snapshot(["A"], true, 2);
      yield* Queue.offer(f.queue, {
        ...next,
        state: { ...next.state, title: "Owner B", latestReasoningEffort: "low" },
      });
      yield* Deferred.await(entered);
      const current = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
      const owner = current.providerThreads.find(
        (p) => p.id === current.thread.activeProviderThreadId,
      )!;
      const now = yield* DateTime.now;
      const localSelection = {
        ...current.thread.modelSelection,
        options: [{ id: "reasoningEffort", value: "high" }],
      };
      yield* f.sink.write({
        events: [
          yield* decodeEvent({
            id: "concurrent-provider-update",
            type: "provider-thread.updated",
            threadId: f.thread.id,
            occurredAt: now,
            payload: { ...owner, lastRunOrdinal: 42 },
          }),
          yield* decodeEvent({
            id: "concurrent-local-selection",
            type: "thread.metadata-updated",
            threadId: f.thread.id,
            occurredAt: now,
            payload: {
              ...current.thread,
              modelSelection: localSelection,
              title: "Owner B",
              ...queueSharedTitle(current.thread, "Owner B", "manual"),
            },
          }),
        ],
      });
      yield* Deferred.succeed(release, undefined);
      yield* f.awaitProjected(2);
      const result = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
      const storedOwner = result.providerThreads.find((p) => p.id === owner.id)!;
      assert.equal(storedOwner.lastRunOrdinal, 42);
      assert.deepEqual(storedOwner.nativeMetadata?.modelSelection?.options, [
        { id: "reasoningEffort", value: "low" },
      ]);
      assert.deepEqual(result.thread.modelSelection, localSelection);
      assert.equal(result.thread.codexTitleSync?.status, "pending");
      yield* Queue.offer(f.queue, {
        ...next,
        state: { ...next.state, title: "Owner B", latestReasoningEffort: "low" },
      });
      const third = f.snapshot(["A"], true, 3);
      yield* Queue.offer(f.queue, {
        ...third,
        state: { ...third.state, title: "Owner C", latestReasoningEffort: "low" },
      });
      yield* f.awaitProjected(3);
      const conflict = (yield* f.projections.getThreadRecords(f.thread.id, handoffFields)).thread;
      assert.equal(conflict.title, "Owner B");
      assert.equal(conflict.codexTitleSync?.status, "conflict");
      assert.deepEqual(conflict.modelSelection, localSelection);
      yield* f.restart;
      const fourth = f.snapshot(["A"], true, 4);
      yield* Queue.offer(f.queue, {
        ...fourth,
        state: { ...fourth.state, title: "Owner C", latestReasoningEffort: "low" },
      });
      yield* f.awaitProjected(4);
      assert.deepEqual(
        (yield* f.projections.getThreadRecords(f.thread.id, handoffFields)).thread.codexTitleSync,
        { ...conflict.codexTitleSync!, observation: { epoch: "epoch", revision: 4 } },
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect(
  "links a completed cache to an idle existing owner only after verifying the same source",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Queue.offer(f.queue, f.snapshot([], true, 1));
      yield* f.awaitProjected(1);
      const fs = yield* FileSystem.FileSystem;
      const sourceId = desktopHistorySourceId(
        normalizeProjectPathForComparison(yield* fs.realPath(f.controls.home)),
      );
      const entry: Contracts.CodexDesktopHistoryEntry = {
        sourceId,
        conversationId: "native",
        title: "Shared",
        cwd: "/workspace",
        archived: false,
        membership: { kind: "none", projectId: null, projectTitle: null, source: "native" },
        status: "cached",
        fetchedAt: 1,
        updatedAt: 1,
        error: null,
      };
      f.controls.historyEntries = [{ ...entry, sourceId: "another-source" }, entry];
      yield* TestClock.adjust("15 seconds");
      yield* f.sink.stream({ threadId: f.thread.id, afterSequence: 0 }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "thread.metadata-updated" &&
            event.payload.codexDesktopHistory?.sourceId === sourceId,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const saved = yield* f.projections.getThreadRecords(f.thread.id, []);
      assert.equal(saved.thread.id, f.thread.id);
      assert.equal(saved.thread.codexDesktopHistory?.sourceId, sourceId);
      assert.equal(saved.thread.codexDesktopHistory?.nativeId, "native");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect.each([undefined, ""])(
  "does not confirm a display fallback as the Desktop title (%s)",
  (title) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.sink.write({
        events: [
          yield* decodeEvent({
            id: "local-title",
            type: "thread.metadata-updated",
            threadId: f.thread.id,
            occurredAt: yield* DateTime.now,
            payload: { ...f.thread, ...queueSharedTitle(f.thread, f.thread.title, "manual") },
          }),
        ],
      });
      const snapshot = f.snapshot([], true, 1);
      yield* Queue.offer(f.queue, {
        ...snapshot,
        state: { ...snapshot.state, title, latestReasoningEffort: "medium" },
      });
      yield* f.awaitProjected(1);
      const thread = (yield* f.projections.getThreadRecords(f.thread.id, handoffFields)).thread;
      assert.equal(thread.codexTitleSync?.status, "pending");
      assert.isNull(thread.codexTitleSync?.ownerTitle);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("applies an owner choice that matches an older projection after two local choices", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const publish = (effort: string, revision: number) => {
      const snapshot = f.snapshot([], true, revision);
      return Queue.offer(f.queue, {
        ...snapshot,
        state: {
          ...snapshot.state,
          title: revision === 1 ? "base" : "marker",
          latestReasoningEffort: effort,
        },
      }).pipe(Effect.andThen(f.awaitProjected(revision)));
    };
    const choose = (effort: string) =>
      Effect.gen(function* () {
        const current = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
        yield* f.sink.write({
          events: [
            yield* decodeEvent({
              id: `local-choice-${effort}`,
              type: "thread.metadata-updated",
              threadId: f.thread.id,
              occurredAt: yield* DateTime.now,
              payload: {
                ...current.thread,
                modelSelection: {
                  ...current.thread.modelSelection,
                  options: [{ id: "reasoningEffort", value: effort }],
                },
              },
            }),
          ],
        });
      });
    yield* publish("medium", 1);
    yield* choose("high");
    yield* publish("medium", 2);
    assert.deepEqual(
      (yield* f.projections.getThreadRecords(f.thread.id, handoffFields)).thread.modelSelection
        .options,
      [{ id: "reasoningEffort", value: "high" }],
    );
    yield* choose("low");
    yield* publish("high", 3);
    const result = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
    assert.deepEqual(result.thread.modelSelection.options, [
      { id: "reasoningEffort", value: "high" },
    ]);
    assert.deepEqual(
      result.providerThreads.find((p) => p.id === result.thread.activeProviderThreadId)
        ?.nativeMetadata?.modelSelection,
      result.thread.modelSelection,
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect(
  "recovers a reserved binding after a failed atomic handoff without starting a follower or losing the native owner",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const before = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
      f.failures.commit = true;
      yield* Queue.offer(f.queue, f.snapshot([], true, 1));
      yield* f.service.attachExisting(f.thread.id, "native").pipe(Effect.flip);
      assert.equal(f.store.bindings().length, 1);
      assert.deepEqual(yield* f.projections.getThreadRecords(f.thread.id, handoffFields), before);
      yield* f.restart;
      yield* f.service.bind("native").pipe(Effect.flip);
      f.failures.commit = false;
      yield* Queue.offer(f.queue, f.snapshot([], true, 2));
      yield* f.service.attachExisting(f.thread.id, "native");
      assert.equal(
        (yield* f.projections.getThreadRecords(f.thread.id, handoffFields)).thread
          .providerInstanceId,
        "codex-desktop",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect(
  "rejects incomplete, busy, stale and mismatched native handoffs before changing ownership",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const records = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
      const owner = records.providerThreads[0]!;
      for (const state of ["held", "pending", "unknown"] as const) {
        assert.throws(
          () =>
            sharedNativeOwner(
              {
                ...records,
                providerThreads: [
                  {
                    ...owner,
                    nativeMetadata: {
                      codexSharedRelease: { state, generation: "g", nativeId: "native" },
                    },
                  },
                ],
              },
              "native",
            ),
          /Confirm native release/,
        );
      }
      assert.throws(() => sharedNativeOwner(records, "different"), /native ID/);
      for (const status of ["pending", "unknown", "unverified", "saved"] as const) {
        assert.throws(
          () =>
            sharedNativeOwner(
              {
                ...records,
                providerThreads: [
                  {
                    ...owner,
                    nativeMetadata: {
                      ...owner.nativeMetadata,
                      codexNativeTitle: {
                        status,
                        version: -1,
                        desiredTitle: "Older title",
                        observedTitle: null,
                      },
                    },
                  },
                ],
              },
              "native",
            ),
          /title/,
        );
      }
      assert.throws(
        () =>
          sharedNativeOwner(
            {
              ...records,
              providerThreads: [
                {
                  ...owner,
                  nativeMetadata: { ...owner.nativeMetadata, codexSharedCreationPending: true },
                },
              ],
            },
            "native",
          ),
        /Confirm native release/,
      );
      const snapshot = f.snapshot([], true, 1);
      const input = {
        records,
        nativeId: "native",
        snapshot,
        history: f.history.value,
        cwd: "/workspace",
        now: yield* DateTime.now,
        eventPrefix: "guard",
      };
      assert.throws(() => sharedNativeHandoffEvents({ ...input, cwd: "/other" }), /same workspace/);
      assert.throws(
        () => sharedNativeHandoffEvents({ ...input, snapshot: f.snapshot([], false, 2) }),
        /complete idle baseline/,
      );
      assert.throws(
        () =>
          sharedNativeHandoffEvents({
            ...input,
            snapshot: { ...snapshot, view: { ...snapshot.view, activeTurnId: "busy" } },
          }),
        /work and requests/,
      );
      assert.throws(
        () =>
          sharedNativeHandoffEvents({
            ...input,
            snapshot: { ...snapshot, state: { ...snapshot.state, requests: [{}] } },
          }),
        /work and requests/,
      );
      assert.throws(
        () => sharedNativeHandoffEvents({ ...input, snapshot: f.snapshot(["A"], true, 2) }),
        /complete idle baseline/,
      );
      assert.throws(
        () =>
          sharedNativeHandoffEvents({
            ...input,
            snapshot: f.snapshot(["A"], true, 2),
            history: { ...f.history.value, turnIds: ["A"] },
          }),
        /user\/assistant text do not match/,
      );
      assert.deepEqual(yield* f.projections.getThreadRecords(f.thread.id, handoffFields), records);
      assert.equal(f.store.bindings().length, 0);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("rejects an unresolved home reference before watching or binding the Desktop owner", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true, "codex", true);
    const before = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
    const failure = yield* f.service.attachExisting(f.thread.id, "native").pipe(Effect.flip);
    assert.match(failure.message, /unresolved CODEX_HOME/);
    assert.deepEqual(f.store.bindings(), []);
    assert.deepEqual(yield* f.projections.getThreadRecords(f.thread.id, handoffFields), before);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect(
  "requires a complete bidirectional native item match, including structured user input",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const records = yield* f.projections.getThreadRecords(f.thread.id, handoffFields);
      const now = yield* DateTime.now;
      const snapshot = f.snapshot(["A"], true, 1);
      const state = {
        title: "Shared",
        cwd: "/workspace",
        latestModel: "test-model",
        threadRuntimeStatus: { type: "idle" },
        turns: [
          {
            turnId: "A",
            status: "completed",
            items: [
              {
                id: "user-A",
                type: "userMessage",
                content: [
                  { type: "text", text: "first" },
                  { type: "text", text: "second" },
                ],
              },
              { id: "assistant-A", type: "agentMessage", text: "reply-A" },
            ],
          },
        ],
      };
      const history: CodexSessionHistory.CodexHistory = {
        nativeThreadId: "native",
        turnIds: ["A"],
        omittedItemTypes: [],
        messages: [
          {
            turnId: "A",
            itemId: "user-A",
            role: "user",
            text: "first\nsecond",
            createdAt: DateTime.formatIso(now),
          },
          {
            turnId: "A",
            itemId: "assistant-A",
            role: "assistant",
            text: "reply-A",
            createdAt: DateTime.formatIso(now),
          },
        ],
      };
      const input = {
        records,
        nativeId: "native",
        snapshot: { ...snapshot, state },
        history,
        cwd: "/workspace",
        now,
        eventPrefix: "identity",
      };
      assert.equal(
        sharedNativeHandoffEvents(input).providerThread.nativeMetadata?.codexDesktopHandoff
          ?.baselineTurnIds[0],
        "A",
      );
      const options = [
        { id: "reasoningEffort", value: "medium" },
        { id: "serviceTier", value: "fast" },
      ];
      const configured = {
        ...records,
        thread: {
          ...records.thread,
          modelSelection: { ...records.thread.modelSelection, options },
        },
      };
      for (const latestReasoningEffort of [undefined, "low"]) {
        const handedOff = sharedNativeHandoffEvents({
          ...input,
          records: configured,
          snapshot: { ...input.snapshot, state: { ...state, latestReasoningEffort } },
        });
        assert.deepEqual(
          handedOff.events
            .flatMap((event) =>
              event.type === "thread.metadata-updated" ? [event.payload.modelSelection] : [],
            )
            .at(0),
          {
            instanceId: Contracts.ProviderInstanceId.make("codex-desktop"),
            model: "test-model",
            options: [
              { id: "reasoningEffort", value: latestReasoningEffort ?? "medium" },
              { id: "serviceTier", value: "fast" },
            ],
          },
        );
      }
      for (const messages of [
        history.messages.slice(1),
        [{ ...history.messages[0]!, text: "old input" }, history.messages[1]!],
        [...history.messages, { ...history.messages[1]!, itemId: "extra-saved" }],
        [{ ...history.messages[0]!, itemId: "different-input" }, history.messages[1]!],
        [{ ...history.messages[0]!, role: "assistant" as const }, history.messages[1]!],
      ])
        assert.throws(
          () => sharedNativeHandoffEvents({ ...input, history: { ...history, messages } }),
          /user\/assistant text do not match/,
        );
      assert.throws(
        () =>
          sharedNativeHandoffEvents({
            ...input,
            history: { ...history, omittedItemTypes: ["userMessage attachment"] },
          }),
        /input attachments is not supported/,
      );
      for (const content of [
        [{ type: "image", url: "fixture" }],
        [
          { type: "text", text: "first" },
          { type: "image", url: "fixture" },
        ],
      ])
        assert.throws(
          () =>
            sharedNativeHandoffEvents({
              ...input,
              snapshot: {
                ...input.snapshot,
                state: {
                  ...state,
                  turns: [
                    {
                      ...state.turns[0],
                      items: [
                        { id: "user-A", type: "userMessage", content },
                        state.turns[0]!.items[1],
                      ],
                    },
                  ],
                },
              },
            }),
          /input attachments is not supported/,
        );
      assert.throws(
        () =>
          sharedNativeHandoffEvents({
            ...input,
            snapshot: {
              ...input.snapshot,
              state: {
                ...state,
                turns: [
                  {
                    ...state.turns[0],
                    items: [
                      { id: "user-A", type: "steeringUserMessage", text: "first\nsecond" },
                      state.turns[0]!.items[1],
                    ],
                  },
                ],
              },
            },
          }),
        /steering inputs is not supported/,
      );
      assert.throws(
        () =>
          sharedNativeHandoffEvents({
            ...input,
            snapshot: {
              ...input.snapshot,
              state: {
                ...state,
                turns: [
                  { ...state.turns[0], params: { toolOutput: { output: "system notification" } } },
                ],
              },
            },
          }),
        /app-tool inputs is not supported/,
      );
      assert.equal(f.store.bindings().length, 0);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect(
  "rechecks directory and owner changes during history I/O and rejects pending submissions",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const fs = yield* FileSystem.FileSystem;
      const originalHome = f.controls.home;
      f.controls.home = yield* fs.makeTempDirectoryScoped();
      assert.match(
        (yield* f.service.attachExisting(f.thread.id, "native").pipe(Effect.flip)).message,
        /different Codex data directories/,
      );
      f.controls.home = originalHome;
      f.controls.beforeRead = Effect.sync(() => {
        f.controls.workspace = "/changed-workspace";
      });
      yield* Queue.offer(f.queue, f.snapshot([], true, 1));
      assert.match(
        (yield* f.service.attachExisting(f.thread.id, "native").pipe(Effect.flip)).message,
        /binding or workspace changed/,
      );
      f.controls.workspace = "/workspace";
      const busy = f.snapshot([], true, 3);
      f.controls.beforeRead = Queue.offer(f.queue, {
        ...busy,
        state: { ...busy.state, threadRuntimeStatus: { type: "active" } },
      }).pipe(Effect.andThen(f.awaitProcessed(3)));
      yield* Queue.offer(f.queue, f.snapshot([], true, 2));
      assert.match(
        (yield* f.service.attachExisting(f.thread.id, "native").pipe(Effect.flip)).message,
        /work and requests/,
      );
      f.controls.beforeRead = Effect.void;
      f.store.rememberTurn("native", {
        runId: "pending-run",
        attemptId: "pending-attempt",
        nodeId: "pending-node",
        providerTurnId: "pending-turn",
        messageId: "pending-message",
        clientMessageId: "pending-client",
        userTurnItemId: "pending-item",
        ordinal: 1,
        providerTurnOrdinal: 1,
        startedAtMs: 1,
        origin: "t3",
      });
      assert.match(
        (yield* f.service.attachExisting(f.thread.id, "native").pipe(Effect.flip)).message,
        /send outcome/,
      );
      assert.equal(f.store.bindings().length, 0);
      assert.equal(
        (yield* f.projections.getThreadRecords(f.thread.id, handoffFields)).thread
          .providerInstanceId,
        "codex",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect(
  "keeps an uncertain answer blocked across a new owner epoch and projects the owner's winning answer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const pending = f.snapshot(["A"], true, 1);
        const raw = {
          id: 7,
          method: "item/tool/requestUserInput",
          params: { turnId: "A", questions: [{ id: "q", header: "Pick", question: "Choose?" }] },
        };
        const state = { ...pending.state, requests: [raw] };
        yield* Queue.offer(f.queue, { ...pending, state });
        yield* f.awaitProjected(1);
        let projection = (yield* f.projections.getThreadSnapshot(f.thread.id)).projection;
        const request = projection.runtimeRequests.find((r) => r.status === "pending")!;
        assert.equal(request.responseCapability.type, "live");
        const responseKey = desktopResponseKey("native", request.nativeRequestRef!.nativeId!);
        const awaitCapability = (type: "live" | "not_resumable") =>
          Effect.gen(function* () {
            while (true) {
              const records = yield* f.projections.getThreadRecords(f.thread.id, [
                "runtimeRequests",
              ]);
              if (
                records.runtimeRequests.find((r) => r.id === request.id)?.responseCapability
                  .type === type
              )
                return;
              yield* Queue.take(f.writes);
            }
          });
        f.store.reserve(responseKey, f.thread.id, { answers: { q: ["B"] } });
        yield* awaitCapability("not_resumable");
        f.store.discardUnsentDelivery(responseKey);
        yield* awaitCapability("live");
        f.store.reserve(
          desktopResponseKey("native", request.nativeRequestRef!.nativeId!),
          f.thread.id,
          { answers: { q: ["B"] } },
        );
        yield* awaitCapability("not_resumable");
        yield* f.restart;
        yield* Queue.offer(f.queue, { ...pending, state });
        yield* Queue.take(f.processed);
        yield* awaitCapability("not_resumable");
        const replay = (yield* f.projections.getThreadSnapshot(f.thread.id)).projection;
        assert.equal(replay.runtimeRequests.length, 1);
        assert.equal(replay.runs.length, 1);
        yield* Queue.offer(f.queue, {
          ...pending,
          state,
          view: { ...pending.view, epoch: "new-epoch", revision: 2 },
        });
        yield* f.awaitProjected(2, "new-epoch");
        projection = (yield* f.projections.getThreadSnapshot(f.thread.id)).projection;
        const current = projection.runtimeRequests.filter((r) => r.status === "pending");
        assert.equal(current.length, 1);
        assert.equal(
          projection.turnItems.filter((item) => item.type === "user_input_request").length,
          1,
        );
        assert.equal(current[0]!.responseCapability.type, "not_resumable");
        assert.equal(
          projection.runtimeRequests.find((r) => r.id === request.id)?.status,
          "expired",
        );
        yield* Queue.offer(f.queue, {
          ...pending,
          view: { ...pending.view, epoch: "new-epoch", revision: 3 },
          state: {
            turns: [
              {
                turnId: "A",
                status: "completed",
                items: [
                  {
                    type: "userInputResponse",
                    id: "answer",
                    requestId: 7,
                    turnId: "A",
                    completed: true,
                    answers: { q: ["A"] },
                  },
                ],
              },
            ],
            requests: [],
          },
        });
        yield* f.awaitProjected(3, "new-epoch");
        projection = (yield* f.projections.getThreadSnapshot(f.thread.id)).projection;
        assert.deepEqual(projection.runtimeRequests.find((r) => r.id === current[0]!.id)?.answers, {
          q: ["A"],
        });
        assert.equal(
          projection.runtimeRequests.some((r) => r.status === "pending"),
          false,
        );
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect(
  "withdraws paths omitted by a shorter authoritative patch, including after importer restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const patch = (paths: string[], completed: boolean, revision: number) => {
          const snapshot = f.snapshot([], true, revision);
          const state = {
            ...snapshot.state,
            turns: [
              {
                turnId: "files",
                status: completed ? "completed" : "inProgress",
                items: [
                  {
                    id: "patch",
                    type: "fileChange",
                    status: completed ? "completed" : "inProgress",
                    changes: paths.map((path) => ({
                      path,
                      kind: { type: "update" },
                      diff: "@@ -1 +1 @@\n-before\n+after\n",
                    })),
                  },
                ],
              },
            ],
          };
          return { ...snapshot, state };
        };
        yield* Queue.offer(f.queue, patch(["a", "b"], false, 1));
        yield* f.awaitProjected(1);
        const before = (yield* f.projections.getThreadSnapshot(f.thread.id)).projection;
        const originalDetails = yield* f.projections.getThreadRecords(f.thread.id, ["turnItems"]);
        const originalFile = originalDetails.turnItems.find(
          (item) => item.type === "file_change" && item.fileName === "b",
        );
        assert.equal(
          originalFile?.type === "file_change" ? originalFile.diffStr : undefined,
          "@@ -1 +1 @@\n-before\n+after\n",
        );
        assert.equal(
          before.turnItems.filter(
            (item) => item.type === "file_change" && item.status === "running",
          ).length,
          2,
        );
        // Drop the in-memory history before the smaller final patch arrives.
        yield* Queue.offer(f.queue, patch(["a"], false, 2));
        yield* f.awaitProjected(2);
        const shorter = yield* f.projections.getThreadRecords(f.thread.id, ["turnItems"]);
        assert.equal(
          shorter.turnItems.find((item) => item.type === "file_change" && item.fileName === "b")
            ?.status,
          "cancelled",
        );
        yield* Queue.offer(f.queue, patch(["a", "b"], false, 3));
        yield* f.awaitProjected(3);
        yield* f.restart;
        yield* Queue.offer(f.queue, patch(["a"], true, 4));
        yield* f.awaitProjected(4);
        const result = (yield* f.projections.getThreadSnapshot(f.thread.id)).projection;
        const files = result.turnItems.filter((item) => item.type === "file_change");
        assert.equal(files.length, 2);
        assert.equal(files.find((item) => item.fileName === "a")?.status, "completed");
        assert.equal(files.find((item) => item.fileName === "b")?.status, "cancelled");
        assert.equal(files.find((item) => item.fileName === "b")?.diffStr, undefined);
        const withdrawnDetails = yield* f.projections.getThreadRecords(f.thread.id, ["turnItems"]);
        const withdrawnFile = withdrawnDetails.turnItems.find(
          (item) => item.type === "file_change" && item.fileName === "b",
        );
        assert.equal(
          withdrawnFile?.type === "file_change" ? withdrawnFile.diffStr : undefined,
          undefined,
        );
        yield* f.restart;
        yield* Queue.offer(f.queue, patch(["a"], true, 5));
        yield* Queue.take(f.processed);
        const replay = (yield* f.projections.getThreadSnapshot(f.thread.id)).projection;
        assert.deepEqual(
          replay.turnItems
            .filter((item) => item.type === "file_change")
            .map((item) => [item.id, item.status]),
          files.map((item) => [item.id, item.status]),
        );
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect(
  "waits for the complete binding baseline before persisting ordinals and commits a reloadable ordinary T3 projection",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Queue.offer(f.queue, f.snapshot(["B", "C"], false, 1));
        yield* Queue.offer(f.queue, f.snapshot(["A", "B", "C"], true, 2));
        yield* Deferred.await(f.committed);
        assert.deepEqual(
          f.store.turnContexts("native").map((row) => [row.nativeTurnId, row.context.ordinal]),
          [
            ["A", 1],
            ["B", 2],
            ["C", 3],
          ],
        );
        const snapshot = yield* f.projections.getThreadSnapshot(f.thread.id);
        assert.equal(snapshot.projection.runs.length, 3);
        assert.equal(
          snapshot.projection.messages.filter((message) => message.role === "assistant").length,
          3,
        );
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect(
  "coordinates the import stream before the local acknowledgement and preserves the original T3 input",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Queue.offer(f.queue, f.snapshot(["A"], true, 1));
        yield* f.awaitProjected(1);
        const first = (yield* f.projections.getThreadSnapshot(f.thread.id)).projection;
        assert.deepEqual(
          first.runs.map((run) => [run.id, run.ordinal]),
          [["desktop-run:A", 1]],
        );
        assert.equal(
          f.store.turnContexts("native").find((row) => row.nativeTurnId === "A")?.context.ordinal,
          1,
        );
        const context = {
          runId: "local-run",
          attemptId: "local-attempt",
          nodeId: "local-node",
          providerTurnId: "desktop-provider-turn:D",
          messageId: "original-message",
          clientMessageId: "local-client",
          userTurnItemId: "original-user-item",
          ordinal: 2,
          providerTurnOrdinal: 2,
          startedAtMs: 1000,
          origin: "t3" as const,
        };
        const now = yield* DateTime.now;
        const original = yield* decodeEvent({
          id: "original-event",
          type: "message.updated",
          threadId: f.thread.id,
          runId: context.runId,
          nodeId: context.nodeId,
          occurredAt: now,
          payload: {
            id: context.messageId,
            threadId: f.thread.id,
            runId: context.runId,
            nodeId: context.nodeId,
            createdBy: "user",
            creationSource: "web",
            role: "user",
            text: "original T3 input with context",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* f.sink.write({ events: [original] });
        f.store.rememberTurn("native", context);
        f.store.beginSubmission("native", context.attemptId);
        const checkingSource = yield* Deferred.make<void>();
        const releaseSource = yield* Deferred.make<void>();
        f.controls.beforeSourceCheck = Effect.gen(function* () {
          f.controls.beforeSourceCheck = Effect.void;
          yield* Deferred.succeed(checkingSource, undefined);
          yield* Deferred.await(releaseSource);
        });
        yield* Queue.offer(f.queue, f.snapshot(["A", "D"], true, 2));
        yield* Deferred.await(checkingSource);
        yield* Deferred.succeed(releaseSource, undefined);
        yield* f.awaitProjected(2);
        assert.isFalse(f.store.turnContexts("native").some((row) => row.nativeTurnId === "D"));
        f.store.rememberTurn("native", context, "D");
        yield* Queue.offer(f.queue, f.snapshot(["A", "D"], true, 3));
        yield* f.awaitProjected(3);
        const snapshot = yield* f.projections.getThreadSnapshot(f.thread.id);
        assert.deepEqual(
          snapshot.projection.runs.map((run) => run.id),
          ["desktop-run:A", "local-run"],
        );
        assert.deepEqual(
          snapshot.projection.runs.map((run) => [run.id, run.ordinal]),
          [
            ["desktop-run:A", 1],
            ["local-run", 2],
          ],
        );
        assert.equal(
          snapshot.projection.messages.find((message) => message.id === context.messageId)?.text,
          "original T3 input with context",
        );
        assert.equal(
          snapshot.projection.providerTurns.filter((turn) => turn.nativeTurnRef?.nativeId === "D")
            .length,
          1,
        );
      }),
    ).pipe(Effect.provide(layerTest)),
);
