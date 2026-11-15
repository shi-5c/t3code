import { makeDesktopSourceLeaseFactory } from "./DesktopSourceLease.ts";
import * as Contracts from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../config.ts";
import {
  buildCodexTurnStartParams,
  CodexProviderCapabilitiesV2,
  makeCodexInputBuilder,
  toCodexUserInputAnswers,
} from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { CodexDesktop, type DesktopCanonicalSnapshot } from "./CodexDesktop.ts";
import { DesktopSyncPersistence } from "./DesktopSyncPersistence.ts";
import { DESKTOP_INSTANCE_ID } from "./identity.ts";
import { sharedCodexAdapter } from "./SharedCodexAdapter.ts";
import { sharedProviderEvents } from "./sharedProviderEvents.ts";
import { record, string } from "./protocol.ts";
import { parseDesktopRequestRef, desktopRequestResponse, desktopResponseKey } from "./requests.ts";
import {
  SharedDesktopHistory,
  desktopFactFingerprint,
  sharedDesktopEvents,
  type SharedDesktopTurnContext,
} from "./sharedProjection.ts";

const sharedDesktopCapabilities: Contracts.OrchestrationV2ProviderCapabilities = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
    supportsProviderSwitchingViaHandoff: false,
  },
  threads: {
    ...CodexProviderCapabilitiesV2.threads,
    canCreateEmptyThread: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
  },
  turns: {
    ...CodexProviderCapabilitiesV2.turns,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
  },
  approvals: {
    ...CodexProviderCapabilitiesV2.approvals,
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
  },
  planning: {
    ...CodexProviderCapabilitiesV2.planning,
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: true,
  },
  tools: { ...CodexProviderCapabilitiesV2.tools, supportsDynamicToolCallbacks: false },
  checkpointing: {
    ...CodexProviderCapabilitiesV2.checkpointing,
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
  },
  context: {
    ...CodexProviderCapabilitiesV2.context,
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
  },
  subagents: {
    ...CodexProviderCapabilitiesV2.subagents,
    supportsSubagents: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
};

export interface SharedDesktopAdapterFactory {
  readonly make: (
    instanceId: Contracts.ProviderInstanceId,
    native?: ProviderAdapter.ProviderAdapterV2["Service"],
  ) => ProviderAdapter.ProviderAdapterV2["Service"];
  readonly validateHome: (home: string) => Effect.Effect<void, Contracts.CodexDesktopError>;
}
export const SharedDesktopAdapterFactory = Context.Reference<
  SharedDesktopAdapterFactory | undefined
>("t3/codexDesktop/SharedDesktopAdapterFactory", { defaultValue: () => undefined });

const isDesktopError = Schema.is(Contracts.CodexDesktopError);
const decodeAppThread = Schema.decodeEffect(Contracts.OrchestrationV2AppThread);
const decodeProviderThread = Schema.decodeEffect(Contracts.OrchestrationV2ProviderThread);

export const layer = Layer.effect(
  SharedDesktopAdapterFactory,
  Effect.gen(function* () {
    const desktop = yield* CodexDesktop;
    const acquireLease = yield* makeDesktopSourceLeaseFactory;
    const persistence = yield* DesktopSyncPersistence;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    const toInput = makeCodexInputBuilder({
      fileSystem: fs,
      attachmentsDir: config.attachmentsDir,
    });
    const driver = Contracts.ProviderDriverKind.make("codex");
    return {
      validateHome: Effect.fn("SharedDesktopAdapter.validateHome")(
        function* (home) {
          const actual = yield* desktop.home;
          const [source, target] = yield* Effect.all([fs.realPath(home), fs.realPath(actual)]);
          if (
            normalizeProjectPathForComparison(source) !== normalizeProjectPathForComparison(target)
          )
            return yield* new Contracts.CodexDesktopError({
              message:
                "Codex Desktop Share requires the Desktop data directory. Keep other accounts in their existing providers.",
              outcomeUnknown: false,
            });
        },
        Effect.mapError((cause) =>
          isDesktopError(cause)
            ? cause
            : new Contracts.CodexDesktopError({
                message: "Unable to verify the Codex Desktop data directory.",
                outcomeUnknown: false,
              }),
        ),
      ),
      make: (instanceId, native) => {
        const follower = ProviderAdapter.ProviderAdapterV2.of({
          instanceId,
          driver,
          getCapabilities: Effect.fn("SharedDesktopAdapter.getCapabilities")(() =>
            Effect.succeed(sharedDesktopCapabilities),
          ),
          planSelectionTransition: Effect.fn("SharedDesktopAdapter.planSelectionTransition")(
            (input) =>
              Effect.succeed(
                input.target.instanceId === DESKTOP_INSTANCE_ID
                  ? { type: "apply_on_next_turn" as const }
                  : {
                      type: "reject" as const,
                      reason:
                        "Shared Desktop conversations cannot switch to an independent provider writer.",
                    },
              ),
          ),
          openSession: Effect.fn("SharedDesktopAdapter.openSession")(
            function* (input) {
              const store = yield* persistence.get.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterOpenSessionError({
                      driver,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              );
              const binding = store
                .bindings()
                .find((binding) => binding.threadId === input.threadId);
              if (
                !binding ||
                (input.initialNativeThreadId &&
                  input.initialNativeThreadId !== binding.conversationId)
              )
                return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver,
                  providerSessionId: input.providerSessionId,
                  cause:
                    "Create the conversation in Codex Desktop and select it in sync mode. Independent T3 creation has no supported Desktop identity path.",
                });
              const lease = yield* acquireLease(yield* desktop.home).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterOpenSessionError({
                      driver,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              );
              const nativeId = binding.conversationId;
              const events = yield* Queue.unbounded<
                ProviderAdapter.ProviderAdapterV2Event,
                ProviderAdapter.ProviderAdapterEventStreamError
              >();
              const first = yield* Deferred.make<DesktopCanonicalSnapshot>();
              let latest: DesktopCanonicalSnapshot | null = null;
              let appThread: Contracts.OrchestrationV2AppThread | null = null;
              let providerThread: Contracts.OrchestrationV2ProviderThread | null = null;
              let starting = false;
              let settling: Deferred.Deferred<void> | null = null;
              const history = new SharedDesktopHistory();
              const fingerprints = new Map<string, string>();
              const liveAttempts = new Map<string, () => void>();
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  for (const release of liveAttempts.values()) release();
                  liveAttempts.clear();
                }),
              );
              const contexts = () => store.resolveTurnContexts(nativeId, latest?.state ?? null);
              const project = Effect.fn("SharedDesktopAdapter.project")(function* () {
                yield* lease.assertCurrent;
                if (!latest?.state || !appThread || !providerThread) return [];
                return sharedDesktopEvents({
                  thread: appThread,
                  nativeId,
                  state: latest.state,
                  epoch: latest.view.epoch,
                  revision: latest.view.revision,
                  now: yield* DateTime.now,
                  history,
                  contexts: contexts(),
                  providerThread,
                  reservedResponseKeys: store.reservedResponseKeys(input.threadId),
                });
              });
              const publish = Effect.fn("SharedDesktopAdapter.publish")(function* () {
                if (starting) return;
                const local = new Set(
                  [...contexts().values()]
                    .filter((context) => context.origin === "t3")
                    .map((context) => context.runId),
                );
                const source = (yield* project()).filter(
                  (event) => event.runId !== undefined && local.has(event.runId),
                );
                for (const event of sharedProviderEvents(source)) {
                  if (
                    event.type === "runtime_request.updated" &&
                    (store.isResponseInFlight(event.runtimeRequest.id) ||
                      store.deliveryState(
                        desktopResponseKey(
                          nativeId,
                          event.runtimeRequest.nativeRequestRef!.nativeId!,
                        ),
                      ) === "acknowledged")
                  )
                    continue;
                  // T3 already committed the primary input, including attachments and context.
                  if (
                    (event.type === "message.updated" && event.message.role === "user") ||
                    (event.type === "turn_item.updated" && event.turnItem.type === "user_message")
                  )
                    continue;
                  const payload =
                    event.type === "provider_turn.updated"
                      ? event.providerTurn
                      : event.type === "node.updated"
                        ? event.node
                        : event.type === "message.updated"
                          ? event.message
                          : event.type === "turn_item.updated"
                            ? event.turnItem
                            : event.type === "runtime_request.updated"
                              ? event.runtimeRequest
                              : event.type === "plan.updated"
                                ? event.plan
                                : null;
                  if (event.type === "turn.terminal") {
                    const key = `terminal:${event.providerTurnId}:${event.status}`;
                    if (fingerprints.has(key)) continue;
                    fingerprints.set(key, key);
                    yield* Queue.offer(events, event);
                    continue;
                  }
                  if (!payload) continue;
                  const key = `${event.type}:${payload.id}`;
                  const fingerprint = desktopFactFingerprint(payload);
                  if (fingerprints.get(key) === fingerprint) continue;
                  fingerprints.set(key, fingerprint);
                  yield* Queue.offer(events, event);
                }
              });
              yield* desktop.watchCanonical(nativeId).pipe(
                Stream.runForEach((snapshot) =>
                  Effect.gen(function* () {
                    latest = snapshot;
                    if (snapshot.view.status !== "ready" || !snapshot.state) return;
                    yield* Deferred.succeed(first, snapshot);
                    yield* publish();
                  }),
                ),
                Effect.catch((cause) =>
                  Queue.fail(
                    events,
                    new ProviderAdapter.ProviderAdapterEventStreamError({
                      driver,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                  ),
                ),
                Effect.forkScoped,
              );
              const snapshot = yield* Deferred.await(first).pipe(
                Effect.timeout("20 seconds"),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterOpenSessionError({
                      driver,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              );
              const now = yield* DateTime.now;
              appThread = yield* decodeAppThread({
                id: input.threadId,
                projectId: binding.projectId,
                title: snapshot.view.title,
                providerInstanceId: instanceId,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimePolicy.runtimeMode,
                interactionMode: input.runtimePolicy.interactionMode,
                branch: null,
                worktreePath: null,
                activeProviderThreadId: `desktop-provider-thread:${nativeId}`,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: input.threadId,
                },
                forkedFrom: null,
                createdBy: "system",
                creationSource: "server",
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                deletedAt: null,
              });
              providerThread = yield* decodeProviderThread({
                id: `desktop-provider-thread:${nativeId}`,
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: input.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId, strength: "strong" },
                nativeConversationHeadRef: null,
                status: snapshot.view.activeTurnId ? "active" : "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                createdAt: now,
                updatedAt: now,
              });
              const session: Contracts.OrchestrationV2ProviderSession = {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd: snapshot.view.cwd,
                model: snapshot.view.model || null,
                capabilities: sharedDesktopCapabilities,
                extensionStatuses: [],
                createdAt: now,
                updatedAt: now,
                lastError: null,
              };
              const checkedThread = Effect.fn("SharedDesktopAdapter.checkedThread")(function* (
                offered: Contracts.OrchestrationV2ProviderThread,
              ) {
                if (offered.nativeThreadRef?.nativeId !== nativeId)
                  return yield* new ProviderAdapter.ProviderAdapterResumeThreadError({
                    driver,
                    providerSessionId: input.providerSessionId,
                    providerThreadId: offered.id,
                    cause: "The native conversation does not match this binding.",
                  });
                providerThread = { ...offered, providerSessionId: input.providerSessionId };
                return providerThread;
              });
              const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
                instanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession: session,
                canResumeAfterRestart: true,
                events: Stream.fromQueue(events),
                hasPendingBackgroundWork: Effect.sync(
                  () => !!latest?.view.activeTurnId || !!latest?.view.pendingRequests,
                ),
                ensureThread: (request) =>
                  request.existingProviderThread && !request.forceNewNativeThread
                    ? checkedThread(request.existingProviderThread)
                    : Effect.fail(
                        new ProviderAdapter.ProviderAdapterEnsureThreadError({
                          driver,
                          threadId: request.threadId,
                          cause: "A Desktop-owned native thread is required.",
                        }),
                      ),
                resumeThread: (request) => checkedThread(request.providerThread),
                startTurn: Effect.fn("SharedDesktopAdapter.startTurn")(
                  function* (turnInput) {
                    yield* lease.assertCurrent;
                    if (
                      turnInput.appThread.codexDesktopHistory &&
                      turnInput.appThread.codexDesktopHistory.sourceId !== lease.sourceId
                    )
                      return yield* new Contracts.CodexDesktopError({
                        message: "This chat belongs to a different Desktop data source.",
                        outcomeUnknown: false,
                      });
                    appThread = turnInput.appThread;
                    providerThread = turnInput.providerThread;
                    if (
                      turnInput.runtimePolicy.cwd &&
                      normalizeProjectPathForComparison(turnInput.runtimePolicy.cwd) !==
                        normalizeProjectPathForComparison(latest?.view.cwd ?? "")
                    )
                      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                        driver,
                        detail: "Shared execution must use the Desktop conversation's workspace.",
                      });
                    const raw = yield* buildCodexTurnStartParams({
                      nativeThreadId: nativeId,
                      codexInput: yield* toInput(turnInput),
                      runtimePolicy: turnInput.runtimePolicy,
                      modelSelection: turnInput.modelSelection,
                      ...(turnInput.appContext ? { appContext: turnInput.appContext } : {}),
                    });
                    const previous = store
                      .turnContexts(nativeId)
                      .find((row) => row.context.attemptId === turnInput.attemptId);
                    const context: SharedDesktopTurnContext = previous?.context ?? {
                      runId: turnInput.runId,
                      attemptId: turnInput.attemptId,
                      nodeId: turnInput.rootNodeId,
                      providerTurnId: `desktop-provider-turn:pending:${turnInput.attemptId}`,
                      messageId: turnInput.message.messageId,
                      clientMessageId: yield* ids.allocate.message({
                        threadId: input.threadId,
                        ordinal: turnInput.runOrdinal,
                      }),
                      userTurnItemId: ids.derive.userTurnItem({
                        messageId: turnInput.message.messageId,
                      }),
                      ordinal: turnInput.runOrdinal,
                      providerTurnOrdinal: turnInput.providerTurnOrdinal,
                      startedAtMs: DateTime.toEpochMillis(yield* DateTime.now),
                      origin: "t3",
                    };
                    const request = { ...raw, clientUserMessageId: context.clientMessageId };
                    yield* desktop.waitUntilIdle(nativeId);
                    yield* lease.assertCurrent;
                    if (!liveAttempts.has(context.attemptId))
                      liveAttempts.set(context.attemptId, store.activateAttempt(context.attemptId));
                    const reservation = yield* Effect.try({
                      try: () => store.reserve(turnInput.attemptId, input.threadId, request),
                      catch: (cause) =>
                        new Contracts.CodexDesktopError({
                          message:
                            cause instanceof Error
                              ? cause.message
                              : "Could not reserve shared input.",
                          outcomeUnknown: false,
                        }),
                    });
                    store.rememberTurn(nativeId, context);
                    let nativeTurnId = previous?.nativeTurnId ?? "";
                    if (reservation.type === "acknowledged")
                      nativeTurnId = string(record(reservation.result).nativeTurnId);
                    else if (reservation.type === "unknown") {
                      contexts();
                      nativeTurnId =
                        store
                          .turnContexts(nativeId)
                          .find((row) => row.context.attemptId === context.attemptId)
                          ?.nativeTurnId ?? "";
                      if (!nativeTurnId)
                        return yield* new Contracts.CodexDesktopError({
                          message:
                            "The earlier send has an unknown outcome. It will not be resent. Check Desktop before retrying.",
                          outcomeUnknown: true,
                        });
                    } else {
                      store.beginSubmission(nativeId, context.attemptId);
                      const settled = yield* Deferred.make<void>();
                      settling = settled;
                      starting = true;
                      try {
                        nativeTurnId = (yield* desktop.start(nativeId, request).pipe(
                          Effect.catch((cause) =>
                            Effect.gen(function* () {
                              const observed = store.resolveTurnContexts(
                                nativeId,
                                latest?.state ?? null,
                              );
                              const accepted = [...observed.entries()].find(
                                ([id, value]) =>
                                  value.attemptId === context.attemptId &&
                                  !/^(?:local|pending):/.test(id),
                              );
                              if (accepted) return { nativeTurnId: accepted[0] };
                              store.finishSubmission(context.attemptId, cause.outcomeUnknown);
                              return yield* cause;
                            }),
                          ),
                        )).nativeTurnId;
                      } finally {
                        starting = false;
                        yield* publish().pipe(
                          Effect.ensuring(Deferred.succeed(settled, undefined)),
                        );
                        settling = null;
                      }
                    }
                    if (!nativeTurnId)
                      return yield* new Contracts.CodexDesktopError({
                        message: "The owner did not identify the submitted turn.",
                        outcomeUnknown: true,
                      });
                    const bound = {
                      ...context,
                      providerTurnId: `desktop-provider-turn:${nativeTurnId}`,
                    };
                    store.rememberTurn(nativeId, bound, nativeTurnId);
                    if (reservation.type !== "acknowledged")
                      store.acknowledge(turnInput.attemptId, { nativeTurnId });
                    yield* publish();
                  },
                  (effect) =>
                    effect.pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapter.ProviderAdapterProtocolError({
                            driver,
                            detail:
                              isDesktopError(cause) && cause.outcomeUnknown
                                ? "The send result is unknown. It will not be resent. Check Desktop, then use Refresh in the shared sidebar to reconcile it."
                                : `Could not submit the shared turn: ${cause instanceof Error ? cause.message : "owner unavailable"}`,
                            payload: cause,
                          }),
                      ),
                    ),
                ),
                steerTurn: (request) =>
                  Effect.fail(
                    new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
                      driver,
                      providerThreadId: request.providerThread.id,
                    }),
                  ),
                interruptTurn: Effect.fn("SharedDesktopAdapter.interruptTurn")(
                  function* (request) {
                    yield* lease.assertCurrent;
                    const row = store
                      .turnContexts(nativeId)
                      .find((row) => row.context.providerTurnId === request.providerTurnId);
                    if (!row?.nativeTurnId) return;
                    yield* desktop.stop({
                      conversationId: nativeId,
                      expectedTurnId: row.nativeTurnId,
                    });
                  },
                  (effect) =>
                    effect.pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapter.ProviderAdapterProtocolError({
                            driver,
                            detail: "Could not interrupt the shared turn.",
                            payload: cause,
                          }),
                      ),
                    ),
                ),
                respondToRuntimeRequest: Effect.fn("SharedDesktopAdapter.respondToRuntimeRequest")(
                  function* (request) {
                    let key = "";
                    const release = store.beginResponse(nativeId, request.requestId);
                    let ownsReservation = false;
                    yield* Effect.gen(function* () {
                      const projected = yield* project();
                      const pending = projected.find(
                        (event) =>
                          event.type === "runtime-request.updated" &&
                          event.payload.id === request.requestId &&
                          event.payload.status === "pending",
                      );
                      if (
                        !pending ||
                        pending.type !== "runtime-request.updated" ||
                        !pending.payload.nativeRequestRef?.nativeId
                      )
                        return yield* new Contracts.CodexDesktopError({
                          message: "This Desktop request is no longer pending.",
                          outcomeUnknown: false,
                        });
                      const nativeRequestId = pending.payload.nativeRequestRef.nativeId;
                      const ref = yield* Effect.try({
                        try: () => parseDesktopRequestRef(nativeRequestId),
                        catch: (cause) =>
                          new Contracts.CodexDesktopError({
                            message: String(cause),
                            outcomeUnknown: false,
                          }),
                      });
                      const raw = (
                        Array.isArray(latest?.state?.requests) ? latest.state.requests : []
                      )
                        .map(record)
                        .find(
                          (value) =>
                            value.id === ref.id &&
                            value.method === ref.method &&
                            record(value.params).turnId === ref.turnId,
                        );
                      if (!raw)
                        return yield* new Contracts.CodexDesktopError({
                          message: "Desktop removed this request.",
                          outcomeUnknown: false,
                        });
                      const allowed = new Set(
                        (Array.isArray(record(raw.params).questions)
                          ? (record(raw.params).questions as unknown[])
                          : []
                        ).map((q) => String(record(q).id)),
                      );
                      const payload = yield* Effect.try({
                        try: () =>
                          desktopRequestResponse(
                            raw,
                            request,
                            toCodexUserInputAnswers(request.answers ?? {}, allowed),
                          ),
                        catch: (cause) =>
                          new Contracts.CodexDesktopError({
                            message:
                              cause instanceof Error ? cause.message : "Invalid Desktop response.",
                            outcomeUnknown: false,
                          }),
                      });
                      key = desktopResponseKey(nativeId, nativeRequestId);
                      const reservation = yield* Effect.try({
                        try: () => store.reserve(key, input.threadId, payload),
                        catch: (cause) =>
                          new Contracts.CodexDesktopError({
                            message:
                              cause instanceof Error
                                ? cause.message
                                : "Could not reserve response.",
                            outcomeUnknown: false,
                          }),
                      });
                      if (reservation.type === "acknowledged") return;
                      if (reservation.type === "unknown")
                        return yield* new Contracts.CodexDesktopError({
                          message:
                            "The previous response has an unknown result and will not be resent.",
                          outcomeUnknown: true,
                        });
                      ownsReservation = true;
                      yield* lease.assertCurrent;
                      yield* desktop.respond(nativeId, ref, payload);
                      store.acknowledge(key, null);
                    }).pipe(
                      Effect.catch((cause) =>
                        Effect.gen(function* () {
                          if (ownsReservation && (!isDesktopError(cause) || !cause.outcomeUnknown))
                            store.discardUnsentDelivery(key);
                          return yield* cause;
                        }),
                      ),
                      Effect.ensuring(Effect.sync(release)),
                      Effect.ensuring(
                        publish().pipe(
                          Effect.catch((cause) =>
                            Effect.logWarning("Shared publication stopped", cause),
                          ),
                        ),
                      ),
                    );
                  },
                  (effect, request) =>
                    effect.pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                            driver,
                            requestId: request.requestId,
                            cause,
                          }),
                      ),
                    ),
                ),
                readThreadSnapshot: Effect.fn("SharedDesktopAdapter.readThreadSnapshot")(
                  function* () {
                    if (settling) yield* Deferred.await(settling);
                    const projected = yield* project();
                    const originals = new Set(
                      [...contexts().values()]
                        .filter((value) => value.origin === "t3")
                        .map((value) => value.messageId),
                    );
                    return {
                      providerThread: providerThread!,
                      providerTurns: projected.flatMap((event) =>
                        event.type === "provider-turn.updated" ? [event.payload] : [],
                      ),
                      messages: projected.flatMap((event) =>
                        event.type === "message.updated" && !originals.has(event.payload.id)
                          ? [event.payload]
                          : [],
                      ),
                      runtimeRequests: projected.flatMap((event) =>
                        event.type === "runtime-request.updated" &&
                        event.payload.status === "pending"
                          ? [event.payload]
                          : [],
                      ),
                      providerPayload: {
                        sharedDesktop: true,
                        epoch: latest?.view.epoch,
                        revision: latest?.view.revision,
                      },
                    };
                  },
                  (effect) =>
                    effect.pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapter.ProviderAdapterProtocolError({
                            driver,
                            detail: "Could not read the shared snapshot.",
                            payload: cause,
                          }),
                      ),
                    ),
                ),
                rollbackThread: (request) =>
                  Effect.fail(
                    new ProviderAdapter.ProviderAdapterRollbackThreadError({
                      driver,
                      providerThreadId: request.providerThread.id,
                      cause: "Rollback is unavailable through the shared owner protocol.",
                    }),
                  ),
                forkThread: (request) =>
                  Effect.fail(
                    new ProviderAdapter.ProviderAdapterForkThreadError({
                      driver,
                      providerThreadId: request.sourceProviderThread.id,
                      cause: "Creating a Desktop-owned fork has no supported T3 identity path.",
                    }),
                  ),
              };
              yield* publish();
              return runtime;
            },
            (effect, input) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterOpenSessionError({
                      driver,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              ),
          ),
        });
        return native
          ? sharedCodexAdapter(follower, native, (threadId) =>
              Effect.gen(function* () {
                const store = yield* persistence.get;
                if (store.bindings().some((binding) => binding.threadId === threadId))
                  return yield* new Contracts.CodexDesktopError({
                    message:
                      "A Desktop binding already exists. Resolve the handoff before opening a native writer.",
                    outcomeUnknown: false,
                  });
              }),
            )
          : follower;
      },
    } satisfies SharedDesktopAdapterFactory;
  }),
);
