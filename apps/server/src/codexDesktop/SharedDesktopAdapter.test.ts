import * as Settings from "../serverSettings.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Contracts from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ServerConfig } from "../config.ts";
import { CodexDesktop, type DesktopCanonicalSnapshot } from "./CodexDesktop.ts";
import { DesktopSyncPersistence } from "./DesktopSyncPersistence.ts";
import { SharedDesktopStore } from "./SharedDesktopStore.ts";
import * as Adapter from "./SharedDesktopAdapter.ts";
import { projectDesktopConversation } from "./projection.ts";
const decodeThread = Schema.decodeEffect(Contracts.OrchestrationV2AppThread);
const decodeProviderThread = Schema.decodeEffect(Contracts.OrchestrationV2ProviderThread);

const fixture = Effect.fn("SharedDesktopAdapterTest.fixture")(function* () {
  const now = yield* DateTime.now;
  const config = yield* ServerConfig;
  const settings = yield* Settings.ServerSettingsService;
  const instanceId = Contracts.ProviderInstanceId.make("codex-desktop");
  const threadId = Contracts.ThreadId.make("original-t3-thread");
  const modelSelection = { instanceId, model: "fixture-model" };
  const runtimePolicy = {
    cwd: "/workspace",
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
  };
  const thread = yield* decodeThread({
    id: threadId,
    threadType: "codex-shared",
    projectId: "original-project",
    title: "Shared",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: runtimePolicy.runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: "desktop-provider-thread:native",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
  });
  const providerThread = yield* decodeProviderThread({
    id: thread.activeProviderThreadId!,
    driver: "codex",
    providerInstanceId: instanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver: "codex", nativeId: "native", strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    nativeMetadata: {
      codexDesktopHandoff: { sourceProviderThreadId: "native-provider", baselineTurnIds: ["old"] },
    },
    createdAt: now,
    updatedAt: now,
  });
  const store = yield* Effect.acquireRelease(
    Effect.sync(() => new SharedDesktopStore(":memory:")),
    (value) => Effect.sync(() => value.close()),
  );
  store.bind({ threadId, conversationId: "native", projectId: thread.projectId, instanceId });
  const snapshot = (
    turns: ReadonlyArray<Record<string, unknown>>,
    revision: number,
  ): DesktopCanonicalSnapshot => {
    const state = {
      title: "Shared",
      cwd: "/workspace",
      latestModel: "fixture-model",
      threadRuntimeStatus: { type: "idle" },
      turns,
    };
    return {
      state,
      view: {
        conversationId: "native",
        status: "ready",
        detail: "fixture",
        epoch: "epoch",
        revision,
        ...projectDesktopConversation(state),
      },
    };
  };
  const old = {
    turnId: "old",
    status: "completed",
    items: [{ id: "old-answer", type: "agentMessage", text: "already saved" }],
  };
  const states = yield* SubscriptionRef.make(snapshot([old], 1));
  const sent: Array<{ nativeId: string; request: Record<string, unknown> }> = [];
  const controls = { unknown: false, unavailable: false };
  const factory = yield* Adapter.SharedDesktopAdapterFactory.pipe(
    Effect.provide(
      Adapter.layer.pipe(
        Layer.provide(
          Layer.mock(CodexDesktop)({
            home: Effect.succeed(config.stateDir),
            watchCanonical: () => SubscriptionRef.changes(states),
            waitUntilIdle: () =>
              controls.unavailable
                ? Effect.fail(
                    new Contracts.CodexDesktopError({
                      message: "Owner unavailable",
                      outcomeUnknown: false,
                    }),
                  )
                : Effect.void,
            start: (nativeId, request) =>
              Effect.gen(function* () {
                sent.push({ nativeId, request });
                if (controls.unknown)
                  return yield* new Contracts.CodexDesktopError({
                    message: "Acknowledgement lost",
                    outcomeUnknown: true,
                  });
                yield* SubscriptionRef.set(
                  states,
                  snapshot(
                    [
                      old,
                      {
                        turnId: "new",
                        status: "completed",
                        params: request,
                        items: [
                          {
                            id: "new-user",
                            clientId: request.clientUserMessageId,
                            type: "userMessage",
                            content: request.input,
                          },
                          { id: "new-answer", type: "agentMessage", text: "owner reply" },
                        ],
                      },
                    ],
                    2,
                  ),
                );
                yield* Effect.yieldNow;
                return { nativeTurnId: "new" };
              }),
          }),
        ),
        Layer.provide(Layer.succeed(DesktopSyncPersistence, { get: Effect.succeed(store) })),
        Layer.provide(IdAllocator.layer),
      ),
    ),
  );
  assert.isDefined(factory);
  const runtime = yield* factory!.make(instanceId).openSession({
    threadId,
    providerSessionId: Contracts.ProviderSessionId.make("desktop-session:native"),
    modelSelection,
    runtimePolicy,
    initialNativeThreadId: "native",
  });
  const attached = yield* runtime.resumeThread({ providerThread });
  const input: ProviderAdapterV2TurnInput = {
    appThread: thread,
    threadId,
    runId: Contracts.RunId.make("new-t3-run"),
    runOrdinal: 2,
    providerTurnOrdinal: 2,
    attemptId: Contracts.RunAttemptId.make("new-t3-attempt"),
    rootNodeId: Contracts.NodeId.make("new-t3-node"),
    providerThread: attached,
    message: {
      messageId: Contracts.MessageId.make("new-t3-message"),
      text: "new input",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy,
  };
  return { runtime, input, sent, controls, settings };
});
const configLayer = ServerConfig.layerTest("/workspace", { prefix: "t3-desktop-adapter-" });
const layer = configLayer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.effect(
      Settings.ServerSettingsService,
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        return yield* Settings.ServerSettingsService.pipe(
          Effect.provide(
            Settings.layerTest({
              providerInstances: {
                [Contracts.ProviderInstanceId.make("codex-desktop")]: {
                  driver: "codex",
                  enabled: true,
                  config: { setupMode: "existing", homePath: config.stateDir },
                },
              },
            }),
          ),
        );
      }),
    ).pipe(Layer.provide(configLayer), Layer.provide(NodeServices.layer)),
  ),
);

it.effect(
  "sends through the owner for an original T3 thread and streams only post-handoff artifacts",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const initial = yield* f.runtime.readThreadSnapshot({
        providerThread: f.input.providerThread,
      });
      assert.deepEqual(initial.messages, []);
      assert.deepEqual(
        initial.providerThread.nativeMetadata,
        f.input.providerThread.nativeMetadata,
      );
      const events = yield* f.runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* f.runtime.startTurn(f.input);
      const output = yield* Fiber.join(events);
      assert.equal(f.sent.length, 1);
      assert.equal(f.sent[0]!.nativeId, "native");
      assert.equal(f.sent[0]!.request.threadId, "native");
      assert.deepEqual(f.sent[0]!.request.input, [{ type: "text", text: "new input" }]);
      assert.deepEqual(
        output.flatMap((event) => (event.type === "message.updated" ? [event.message.text] : [])),
        ["owner reply"],
      );
      // Replaying the same durable attempt reuses its acknowledgement, never another owner send.
      yield* f.runtime.startTurn(f.input);
      assert.equal(f.sent.length, 1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("blocks an unavailable owner and never resends an unknown submission", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.controls.unavailable = true;
    yield* f.runtime.startTurn(f.input).pipe(Effect.flip);
    assert.equal(f.sent.length, 0);
    f.controls.unavailable = false;
    f.controls.unknown = true;
    yield* f.runtime.startTurn(f.input).pipe(Effect.flip);
    yield* f.runtime.startTurn(f.input).pipe(Effect.flip);
    assert.equal(f.sent.length, 1);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each(["disabled", "source changed"])(
  "blocks new sends on an existing follower when Share is %s",
  (problem) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const instanceId = Contracts.ProviderInstanceId.make("codex-desktop");
      const previous = (yield* f.settings.getSettings).providerInstances[instanceId]!;
      yield* f.settings.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: {
          ...previous,
          ...(problem === "disabled"
            ? { enabled: false }
            : { config: { setupMode: "existing", homePath: "/another-source" } }),
        },
      });
      yield* f.runtime.startTurn(f.input).pipe(Effect.flip);
      yield* f.runtime
        .interruptTurn({
          providerThread: f.input.providerThread,
          providerTurnId: Contracts.ProviderTurnId.make("old-source-turn"),
        })
        .pipe(Effect.flip);
      assert.equal(f.sent.length, 0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
