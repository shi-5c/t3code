import { makeDesktopSourceLeaseFactory } from "./DesktopSourceLease.ts";
import { observeSharedTitle } from "./sharedTitle.ts";
import { desktopPermissions } from "./projection.ts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { desktopResponseKey } from "./requests.ts";
import * as Contracts from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadCommands from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as CodexSessionHistory from "../project/CodexSessionHistory.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import {
  handoffFields,
  sharedNativeOwner,
  sharedNativeHandoffEvents,
} from "./sharedNativeHandoff.ts";
import { CodexDesktop, type DesktopCanonicalSnapshot } from "./CodexDesktop.ts";
import { DesktopSyncPersistence } from "./DesktopSyncPersistence.ts";
import { DESKTOP_INSTANCE_ID } from "./identity.ts";
import { DesktopHistoryLibrary } from "./DesktopHistoryLibrary.ts";
import { record, string } from "./protocol.ts";
import {
  desktopEventFingerprint,
  desktopModelSelection,
  sharedDesktopEvents,
  SharedDesktopHistory,
  type SharedDesktopTurnContext,
} from "./sharedProjection.ts";
import type { SharedDesktopBinding } from "./SharedDesktopStore.ts";

const isDesktopError = Schema.is(Contracts.CodexDesktopError);
const decodeAppThread = Schema.decodeEffect(Contracts.OrchestrationV2AppThread);
const decodeProviderThread = Schema.decodeEffect(Contracts.OrchestrationV2ProviderThread);
const decodeCodexConfig = Schema.decodeEffect(Contracts.CodexSettings);
const sameModelSelection = Schema.toEquivalence(Contracts.ModelSelection);
const sameProviderConfig = Schema.toEquivalence(
  Schema.UndefinedOr(Contracts.ProviderInstanceConfig),
);
const failure = (cause: unknown) =>
  isDesktopError(cause)
    ? cause
    : new Contracts.CodexDesktopError({
        message: cause instanceof Error ? cause.message : "Shared Desktop synchronization failed.",
        outcomeUnknown: false,
      });
const instanceId = Contracts.ProviderInstanceId.make(DESKTOP_INSTANCE_ID);

export class SharedDesktopThreads extends Context.Service<
  SharedDesktopThreads,
  {
    readonly enable: Effect.Effect<void, Contracts.CodexDesktopError>;
    readonly attachExisting: (
      threadId: Contracts.ThreadId,
      nativeId: string,
    ) => Effect.Effect<Contracts.CodexDesktopBinding, Contracts.CodexDesktopError>;
    readonly bind: (
      nativeId: string,
      dismissUnsentAttemptId?: string,
    ) => Effect.Effect<Contracts.CodexDesktopBinding, Contracts.CodexDesktopError>;
  }
>()("t3/codexDesktop/SharedDesktopThreads") {}

export const layer = Layer.effect(
  SharedDesktopThreads,
  Effect.gen(function* () {
    const desktop = yield* CodexDesktop;
    const persistence = yield* DesktopSyncPersistence;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const projects = yield* ProjectService.ProjectService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const instances = yield* ProviderInstances.ProviderInstanceRegistry;
    const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
    const threadCommands = yield* ThreadCommands.ThreadCommandExecutor;
    const nativeHistory = yield* CodexSessionHistory.CodexSessionHistory;
    const environment = yield* HostProcess.Environment;
    const home = yield* HostProcess.HomeDirectory;
    const scope = yield* Scope.Scope;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const bindLock = yield* Semaphore.make(1);
    const library = yield* Effect.serviceOption(DesktopHistoryLibrary);
    const assertHistorySource = Effect.fn("SharedDesktopThreads.assertHistorySource")(function* (
      thread: Contracts.OrchestrationV2AppThread,
    ) {
      if (!thread.codexDesktopHistory) return;
      if (
        Option.isNone(library) ||
        !(yield* library.value.mayProject(thread.codexDesktopHistory.sourceId))
      )
        return yield* failure(
          new Error(
            "The saved Desktop history belongs to a different or unavailable source. Its binding is preserved.",
          ),
        );
    });
    const acquireLease = yield* makeDesktopSourceLeaseFactory;
    const running = new Map<string, Effect.Effect<void, Contracts.CodexDesktopError>>();
    const ensureProvider = Effect.fn("SharedDesktopThreads.ensureProvider")(function* (
      createIfMissing: boolean,
    ) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* instances.subscribeChanges;
          const current = yield* settings.getSettings;
          const existing = current.providerInstances[instanceId];
          if (existing && existing.driver !== "codex")
            return yield* failure(
              new Error("The reserved shared provider identifier is already in use."),
            );
          if (!existing && !createIfMissing)
            return yield* failure(
              new Error(
                "Enable the shared Codex Desktop provider on the host before binding a conversation.",
              ),
            );
          if (existing?.enabled === false)
            return yield* failure(
              new Error("The shared Codex Desktop provider is disabled in host settings."),
            );
          if (!existing)
            yield* settings.updateProviderInstance({
              operation: "create",
              instanceId,
              instance: {
                driver: Contracts.ProviderDriverKind.make("codex"),
                displayName: "Codex Desktop Share",
                enabled: true,
                config: {
                  setupMode: "existing",
                  homePath: yield* desktop.home,
                  shadowHomePath: "",
                },
              },
            });
          yield* Stream.concat(Stream.make(undefined), Stream.fromSubscription(changes)).pipe(
            Stream.mapEffect(() => instances.getInstance(instanceId)),
            Stream.filter((value) => value !== undefined),
            Stream.take(1),
            Stream.runDrain,
            Effect.timeout("20 seconds"),
          );
        }),
      );
    });
    const ensureSession = Effect.fn("SharedDesktopThreads.ensureSession")(function* (
      thread: Contracts.OrchestrationV2AppThread,
      providerThread: Contracts.OrchestrationV2ProviderThread,
      nativeId: string,
    ) {
      const sessionId = Contracts.ProviderSessionId.make(`desktop-session:${nativeId}`);
      const existing = yield* sessions.get(sessionId);
      if (Option.isSome(existing)) return existing.value;
      const project = yield* projects.getById(thread.projectId);
      const cwd = Option.isSome(project) ? project.value.workspaceRoot : null;
      const runtime = yield* sessions.open({
        threadId: thread.id,
        providerSessionId: sessionId,
        modelSelection: thread.modelSelection,
        runtimePolicy: {
          cwd,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
        },
        initialNativeThreadId: nativeId,
      });
      const attached = yield* runtime.resumeThread({ providerThread });
      yield* sink.write({
        events: [
          {
            id: Contracts.EventId.make(
              `desktop-session:${sessionId}:${DateTime.toEpochMillis(yield* DateTime.now)}`,
            ),
            type: "provider-thread.updated",
            threadId: thread.id,
            occurredAt: yield* DateTime.now,
            payload: attached,
          },
        ],
      });
      return runtime;
    });
    const startBinding = Effect.fn("SharedDesktopThreads.startBinding")(function* (
      binding: SharedDesktopBinding,
    ) {
      const initial = yield* projections.getThreadRecords(
        Contracts.ThreadId.make(binding.threadId),
        ["providerThreads"],
      );
      yield* assertHistorySource(initial.thread);
      const existingLease = running.get(binding.threadId);
      if (existingLease) {
        yield* existingLease;
        return;
      }
      // A reserved binding can survive a failed main-store commit. It must not start a follower yet.
      if (
        initial.thread.providerInstanceId !== instanceId ||
        Contracts.codexSharedOwnerOf(initial.thread) !== "desktop" ||
        !initial.providerThreads.some(
          (value) =>
            value.id === initial.thread.activeProviderThreadId &&
            value.providerInstanceId === instanceId &&
            value.nativeThreadRef?.nativeId === binding.conversationId,
        )
      )
        return;
      yield* ensureProvider(false);
      const lease = yield* acquireLease(
        yield* desktop.home,
        initial.thread.codexDesktopHistory?.sourceId,
      );
      running.set(binding.threadId, lease.assertCurrent);
      const bindingStore = yield* persistence.get;
      let latestSnapshot: DesktopCanonicalSnapshot | null = null;
      const changes = Stream.callback<() => DesktopCanonicalSnapshot | null>(
        (queue) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              bindingStore.subscribe(binding.conversationId, () => {
                Queue.offerUnsafe(queue, () => latestSnapshot);
              }),
            ),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        { bufferSize: 1, strategy: "sliding" },
      );
      const history = new SharedDesktopHistory();
      const fingerprints = new Map<string, string>();
      const process = Effect.fn("SharedDesktopThreads.project")(function* (
        snapshot: DesktopCanonicalSnapshot,
      ) {
        yield* lease.assertCurrent;
        latestSnapshot = snapshot;
        if (snapshot.view.status !== "ready" || !snapshot.state) return;
        const threadId = Contracts.ThreadId.make(binding.threadId);
        const records = yield* projections.getThreadRecords(threadId, [
          "providerThreads",
          "runtimeRequests",
          "nodes",
          "turnItems",
        ]);
        yield* assertHistorySource(records.thread);
        if (records.thread.archivedAt !== null || records.thread.deletedAt !== null) return;
        const providerThread = records.providerThreads.find(
          (value) =>
            value.id === records.thread.activeProviderThreadId &&
            value.providerInstanceId === instanceId &&
            value.nativeThreadRef?.nativeId === binding.conversationId,
        );
        if (!providerThread) return;
        const runtime = yield* ensureSession(
          records.thread,
          providerThread,
          binding.conversationId,
        );
        const attachedProviderThread = {
          ...providerThread,
          providerSessionId: runtime.providerSessionId ?? providerThread.providerSessionId,
        };
        const store = yield* persistence.get;
        const contexts = yield* Effect.try({
          try: () => store.resolveTurnContexts(binding.conversationId, snapshot.state),
          catch: failure,
        });
        const baseline = new Set(
          providerThread.nativeMetadata?.codexDesktopHandoff?.baselineTurnIds ?? [],
        );
        const turns = history
          .merge(snapshot.state)
          .filter((turn) => !baseline.has(string(turn.turnId)));
        if (!history.ready) return;
        if (turns.some((turn) => !contexts.has(string(turn.turnId)))) {
          const known = yield* projections.getThreadRecords(threadId, [
            "runs",
            "nodes",
            "providerTurns",
          ]);
          let ordinal = Math.max(
            0,
            ...known.runs.map((run) => run.ordinal),
            ...Array.from(contexts.values(), (context) => context.ordinal),
          );
          for (const [index, turn] of turns.entries()) {
            const nativeTurnId = string(turn.turnId);
            if (!nativeTurnId || contexts.has(nativeTurnId)) continue;
            const existingTurn = known.providerTurns.find(
              (value) =>
                value.providerThreadId === providerThread.id &&
                value.nativeTurnRef?.nativeId === nativeTurnId,
            );
            const existingNode = existingTurn
              ? known.nodes.find((value) => value.id === existingTurn.nodeId)
              : undefined;
            const existingRun = existingNode?.runId
              ? known.runs.find((value) => value.id === existingNode.runId)
              : undefined;
            const context: SharedDesktopTurnContext = {
              runId: existingRun?.id ?? `desktop-run:${nativeTurnId}`,
              attemptId: existingRun?.activeAttemptId ?? `desktop-attempt:${nativeTurnId}`,
              nodeId: existingNode?.id ?? `desktop-node:${nativeTurnId}`,
              providerTurnId: existingTurn?.id ?? `desktop-provider-turn:${nativeTurnId}`,
              messageId:
                existingRun?.userMessageId ??
                `desktop-message:${binding.conversationId}:${nativeTurnId}:input`,
              clientMessageId: string(record(turn.params).clientUserMessageId),
              userTurnItemId: existingRun
                ? `turn-item:message:${existingRun.userMessageId}`
                : `desktop-item:${binding.conversationId}:${nativeTurnId}:input`,
              ordinal: existingRun?.ordinal ?? ++ordinal,
              providerTurnOrdinal: existingTurn?.ordinal ?? index + 1,
              startedAtMs:
                typeof turn.turnStartedAtMs === "number"
                  ? turn.turnStartedAtMs
                  : DateTime.toEpochMillis(records.thread.createdAt),
              origin:
                existingRun && !String(existingRun.id).startsWith("desktop-run:")
                  ? "t3"
                  : "desktop",
            };
            const imported = yield* Effect.try({
              try: () => store.rememberImportedTurn(binding.conversationId, context, nativeTurnId),
              catch: failure,
            });
            if (!imported) continue;
            contexts.set(nativeTurnId, context);
          }
        }
        const previousOwnerSelection = providerThread.nativeMetadata?.modelSelection;
        const currentOwnerSelection = desktopModelSelection(
          previousOwnerSelection ?? records.thread.modelSelection,
          snapshot.state,
        );
        const syncModelSelection =
          previousOwnerSelection === undefined ||
          !sameModelSelection(previousOwnerSelection, currentOwnerSelection);
        const saved = Option.isSome(library)
          ? yield* library.value.list.pipe(Effect.orElseSucceed(() => []))
          : [];
        const sourceEntry = saved.find(
          (entry) =>
            entry.sourceId === lease.sourceId &&
            entry.conversationId === binding.conversationId &&
            entry.fetchedAt !== null,
        );
        const now = yield* DateTime.now;
        const events = yield* Effect.try({
          try: () =>
            sharedDesktopEvents({
              thread: records.thread,
              nativeId: binding.conversationId,
              state: snapshot.state!,
              epoch: snapshot.view.epoch,
              revision: snapshot.view.revision,
              now,
              history,
              contexts,
              providerThread: attachedProviderThread,
              runtimeRequests: records.runtimeRequests,
              knownTurnItems: records.turnItems,
              reservedResponseKeys: store.reservedResponseKeys(binding.threadId),
              syncModelSelection,
              requireContexts: true,
            }),
          catch: failure,
        });
        // The importer must not rewrite provider ownership or run associations.
        const reconciledEvents: Contracts.OrchestrationV2DomainEvent[] = events.filter(
          (event) => event.type !== "provider-thread.updated",
        );
        for (const request of records.runtimeRequests) {
          const prefix = `desktop-request:${binding.conversationId}:`;
          if (
            request.status !== "pending" ||
            !request.id.startsWith(prefix) ||
            request.id.startsWith(`${prefix}${snapshot.view.epoch}:`)
          )
            continue;
          reconciledEvents.push({
            id: Contracts.EventId.make(
              `desktop-request-expired:${snapshot.view.epoch}:${request.id}`,
            ),
            type: "runtime-request.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...request,
              status: "expired",
              resolvedAt: now,
              responseCapability: {
                type: "not_resumable",
                reason: "The Desktop request belongs to an older connection.",
              },
            },
          });
          const node = records.nodes.find((node) => node.id === request.nodeId);
          if (
            node &&
            !events.some(
              (event) =>
                event.type === "node.updated" &&
                event.payload.id === node.id &&
                event.payload.runtimeRequestId !== request.id,
            )
          )
            reconciledEvents.push({
              id: Contracts.EventId.make(
                `desktop-request-node-expired:${snapshot.view.epoch}:${node.id}`,
              ),
              type: "node.updated",
              threadId,
              occurredAt: now,
              payload: { ...node, status: "cancelled", completedAt: now },
            });
        }
        const byRun = new Map(Array.from(contexts.values(), (context) => [context.runId, context]));
        const changed = reconciledEvents.filter((event) => {
          // Local choices may have changed since the last imported fingerprint.
          // Reconcile metadata against the current row inside the transaction.
          if (event.type === "thread.metadata-updated") return true;
          if (event.type === "runtime-request.updated" && event.payload.status === "pending") {
            const saved = records.runtimeRequests.find(
              (request) => request.id === event.payload.id,
            );
            if (
              saved?.status === "resolved" &&
              (store.isResponseInFlight(saved.id) ||
                (saved.nativeRequestRef?.nativeId &&
                  store.deliveryState(
                    desktopResponseKey(binding.conversationId, saved.nativeRequestRef.nativeId),
                  ) === "acknowledged"))
            )
              return false;
            if (saved?.status !== "pending") return true;
          }
          const context = event.runId ? byRun.get(event.runId) : undefined;
          if (context?.origin === "t3") {
            if (
              (event.type === "message.updated" && event.payload.id === context.messageId) ||
              (event.type === "turn-item.updated" &&
                event.payload.type === "user_message" &&
                event.payload.messageId === context.messageId)
            )
              return false;
            if (
              store.isAttemptLive(context.attemptId) &&
              (event.type === "run.updated" || event.type === "run-attempt.updated")
            )
              return false;
          }
          const key = `${event.type}:${"id" in event.payload ? event.payload.id : event.id}`;
          return fingerprints.get(key) !== desktopEventFingerprint(event);
        });
        if (!changed.length) return;
        // Local delivery changes can publish a different fact at the same owner revision.
        const publication = yield* randomUuidV4;
        const committedEvents = yield* threadCommands.withLock(
          threadId,
          sink.withProviderBatch(
            Effect.gen(function* () {
              yield* lease.assertCurrent;
              const current = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
              yield* assertHistorySource(current.thread);
              const currentProvider = current.providerThreads.find(
                (value) => value.id === current.thread.activeProviderThreadId,
              );
              if (
                current.thread.archivedAt !== null ||
                current.thread.deletedAt !== null ||
                current.thread.providerInstanceId !== instanceId ||
                Contracts.codexSharedOwnerOf(current.thread) !== "desktop" ||
                currentProvider?.id !== providerThread.id ||
                currentProvider.providerInstanceId !== instanceId ||
                currentProvider.nativeThreadRef?.nativeId !== binding.conversationId
              )
                return [];
              const previousSelection = currentProvider.nativeMetadata?.modelSelection;
              const ownerSelection = desktopModelSelection(
                previousSelection ?? current.thread.modelSelection,
                snapshot.state!,
              );
              const ownerChanged =
                previousSelection === undefined ||
                !sameModelSelection(previousSelection, ownerSelection);
              const selectionUnchanged = sameModelSelection(
                records.thread.modelSelection,
                current.thread.modelSelection,
              );
              const rebased: Contracts.OrchestrationV2DomainEvent[] = changed.flatMap((event) => {
                if (event.type === "provider-thread.updated") return [];
                if (event.type !== "thread.metadata-updated") return [event];
                const payload = {
                  ...current.thread,
                  ...(sourceEntry
                    ? {
                        codexDesktopHistory: {
                          sourceId: lease.sourceId,
                          nativeId: binding.conversationId,
                          membership: sourceEntry.membership,
                          attachedToThreadId: sourceEntry.attachedToThreadId ?? null,
                          fetchedAt: sourceEntry.fetchedAt!,
                        },
                      }
                    : {}),
                  // Stamp every owner observation once, even if a local rename raced it.
                  // Store-change replay cannot turn that old observation into a new acknowledgement.
                  ...(typeof snapshot.state?.title === "string"
                    ? observeSharedTitle(
                        current.thread,
                        snapshot.state.title,
                        { epoch: snapshot.view.epoch, revision: snapshot.view.revision },
                        current.thread.title === records.thread.title &&
                          current.thread.codexTitleSync?.version ===
                            records.thread.codexTitleSync?.version,
                      )
                    : {}),
                  modelSelection:
                    ownerChanged && selectionUnchanged
                      ? desktopModelSelection(current.thread.modelSelection, snapshot.state!)
                      : current.thread.modelSelection,
                  runtimeMode:
                    desktopPermissions(snapshot.state!).runtimeMode ?? current.thread.runtimeMode,
                  updatedAt: now,
                };
                return Schema.toEquivalence(Contracts.OrchestrationV2AppThread)(
                  { ...current.thread, updatedAt: now },
                  payload,
                )
                  ? []
                  : [{ ...event, payload }];
              });
              if (ownerChanged)
                rebased.push({
                  id: Contracts.EventId.make(
                    `desktop-event:${snapshot.view.epoch}:${snapshot.view.revision}:owner-options:${currentProvider.id}`,
                  ),
                  type: "provider-thread.updated",
                  threadId,
                  occurredAt: now,
                  payload: {
                    ...currentProvider,
                    nativeMetadata: {
                      ...currentProvider.nativeMetadata,
                      modelSelection: ownerSelection,
                    },
                    updatedAt: now,
                  },
                });
              if (rebased.length)
                yield* sink.write({
                  events: rebased.map((event, index) => ({
                    ...event,
                    id: Contracts.EventId.make(`${event.id}:${publication}:${index}`),
                  })),
                });
              return rebased;
            }),
          ),
        );
        for (const event of committedEvents)
          fingerprints.set(
            `${event.type}:${"id" in event.payload ? event.payload.id : event.id}`,
            desktopEventFingerprint(event),
          );
      });
      yield* Stream.mergeAll(
        [
          desktop
            .watchCanonical(binding.conversationId)
            .pipe(Stream.map((snapshot) => () => snapshot)),
          changes,
          // Backfill can finish after an idle owner has sent its last snapshot.
          Stream.tick("15 seconds").pipe(
            Stream.drop(1),
            Stream.mapEffect(() => lease.assertCurrent),
            Stream.map(() => () => latestSnapshot),
          ),
          Stream.unwrap(settings.subscribeChanges).pipe(
            Stream.mapEffect(() => lease.assertCurrent),
            Stream.map(() => () => null),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Stream.runForEach((read) => {
          const snapshot = read();
          return snapshot ? process(snapshot) : Effect.void;
        }),
        Effect.catch((cause) =>
          Effect.logWarning("Shared Desktop projection stopped", failure(cause)),
        ),
        Effect.ensuring(Effect.sync(() => running.delete(binding.threadId))),
        Effect.forkIn(scope),
      );
    });
    const bind = Effect.fn("SharedDesktopThreads.bind")(
      function* (nativeId: string, dismissUnsentAttemptId?: string) {
        yield* ensureProvider(false);
        const store = yield* persistence.get;
        if (dismissUnsentAttemptId)
          yield* Effect.try({
            try: () => store.dismissUncertain(nativeId, dismissUnsentAttemptId),
            catch: failure,
          });
        const existing = store.bindings().find((binding) => binding.conversationId === nativeId);
        if (existing) {
          const current = yield* projections.getThreadRecords(
            Contracts.ThreadId.make(existing.threadId),
            ["providerThreads"],
          );
          if (
            current.thread.providerInstanceId !== instanceId ||
            Contracts.codexSharedOwnerOf(current.thread) !== "desktop"
          )
            return yield* failure(
              new Error("Finish connecting to Desktop from the original T3 conversation."),
            );
          yield* startBinding(existing);
          return {
            threadId: Contracts.ThreadId.make(existing.threadId),
            uncertain: store.uncertainSubmissions(nativeId),
          };
        }
        // Recover a crash after the event-store commit but before the private binding commit.
        const recovered = yield* projections
          .getThreadRecords(Contracts.ThreadId.make(`codex-desktop:${nativeId}`), [
            "providerThreads",
          ])
          .pipe(
            Effect.asSome,
            Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeedNone }),
          );
        if (Option.isSome(recovered)) {
          const records = recovered.value;
          yield* assertHistorySource(records.thread);
          const providerThread = records.providerThreads.find(
            (value) =>
              value.providerInstanceId === instanceId &&
              value.nativeThreadRef?.nativeId === nativeId,
          );
          if (!providerThread || records.thread.providerInstanceId !== instanceId)
            return yield* failure(
              new Error("The recovered thread has a conflicting native binding."),
            );
          const binding = {
            threadId: String(records.thread.id),
            conversationId: nativeId,
            projectId: String(records.thread.projectId),
            instanceId: String(instanceId),
          };
          yield* Effect.try({ try: () => store.bind(binding), catch: failure });
          yield* ensureSession(records.thread, providerThread, nativeId);
          yield* startBinding(binding);
          return { threadId: records.thread.id, uncertain: store.uncertainSubmissions(nativeId) };
        }
        const snapshot = yield* desktop.watchCanonical(nativeId).pipe(
          Stream.filter((value) => value.view.status === "ready" && value.state !== null),
          Stream.take(1),
          Stream.runHead,
          Effect.timeout("20 seconds"),
        );
        if (Option.isNone(snapshot))
          return yield* failure(new Error("The Desktop owner did not provide a snapshot."));
        const view = snapshot.value.view;
        const modelSelection = desktopModelSelection(
          { instanceId, model: view.model || "unknown" },
          snapshot.value.state!,
        );
        if (!view.cwd)
          return yield* failure(new Error("The Desktop conversation has no workspace."));
        const existingProject = yield* projects.getByWorkspaceRoot(view.cwd);
        const project = Option.isSome(existingProject)
          ? existingProject.value
          : yield* projects.create({
              commandId: Contracts.CommandId.make(`desktop-project:${nativeId}`),
              projectId: Contracts.ProjectId.make(`desktop-project:${nativeId}`),
              title: path.basename(view.cwd) || "Codex Desktop",
              workspaceRoot: view.cwd,
              defaultThreadType: "codex-shared",
              defaultModelSelection: modelSelection,
            });
        const now = yield* DateTime.now;
        const thread = yield* decodeAppThread({
          threadType: "codex-shared",
          codexSharedOwner: "desktop",
          id: `codex-desktop:${nativeId}`,
          projectId: project.id,
          title: view.title,
          codexTitleSync: {
            status:
              typeof snapshot.value.state?.title === "string" && snapshot.value.state.title.trim()
                ? "confirmed"
                : "pending",
            version: 0,
            desiredTitle: view.title,
            ownerTitle:
              typeof snapshot.value.state?.title === "string" && snapshot.value.state.title.trim()
                ? snapshot.value.state.title
                : null,
            expectedOwnerTitle:
              typeof snapshot.value.state?.title === "string" && snapshot.value.state.title.trim()
                ? snapshot.value.state.title
                : null,
            source: "desktop",
          },
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: `desktop-provider-thread:${nativeId}`,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: `codex-desktop:${nativeId}`,
          },
          forkedFrom: null,
          createdBy: "system",
          creationSource: "server",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          deletedAt: null,
        });
        const providerThread = yield* decodeProviderThread({
          id: `desktop-provider-thread:${nativeId}`,
          driver: "codex",
          providerInstanceId: instanceId,
          providerSessionId: null,
          appThreadId: thread.id,
          ownerNodeId: null,
          nativeThreadRef: { driver: "codex", nativeId, strength: "strong" },
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
        const committed = yield* sink.write({
          unlessNativeThreadOwned: { ...providerThread, anyProviderInstance: true },
          events: [
            {
              id: Contracts.EventId.make(`desktop-thread:${nativeId}`),
              type: "thread.created",
              threadId: thread.id,
              occurredAt: now,
              payload: thread,
            },
            {
              id: Contracts.EventId.make(`desktop-provider-thread:${nativeId}`),
              type: "provider-thread.updated",
              threadId: thread.id,
              occurredAt: now,
              payload: providerThread,
            },
          ],
        });
        if (!committed.length)
          return yield* failure(
            new Error("This native conversation is already represented by another T3 thread."),
          );
        const binding = {
          threadId: String(thread.id),
          conversationId: nativeId,
          projectId: String(project.id),
          instanceId: String(instanceId),
        };
        yield* Effect.try({ try: () => store.bind(binding), catch: failure });
        yield* ensureSession(thread, providerThread, nativeId);
        yield* startBinding(binding);
        return { threadId: thread.id, uncertain: store.uncertainSubmissions(nativeId) };
      },
      (effect) => effect.pipe(Effect.mapError(failure), bindLock.withPermits(1)),
    );
    const attachExisting = Effect.fn("SharedDesktopThreads.attachExisting")(
      function* (threadId: Contracts.ThreadId, nativeId: string) {
        yield* ensureProvider(false);
        const store = yield* persistence.get;
        const records = yield* projections.getThreadRecords(threadId, handoffFields);
        yield* assertHistorySource(records.thread);
        const binding: SharedDesktopBinding = {
          threadId,
          conversationId: nativeId,
          projectId: records.thread.projectId,
          instanceId,
        };
        if (Contracts.codexSharedOwnerOf(records.thread) === "desktop") {
          const active = records.providerThreads.find(
            (value) => value.id === records.thread.activeProviderThreadId,
          );
          if (
            active?.providerInstanceId !== instanceId ||
            active.nativeThreadRef?.nativeId !== nativeId
          )
            return yield* failure(
              new Error("The saved Desktop binding has changed. Refresh this conversation."),
            );
          yield* Effect.try({ try: () => store.bind(binding), catch: failure });
          yield* startBinding(binding);
          return { threadId, uncertain: store.uncertainSubmissions(nativeId) };
        }
        const owner = yield* Effect.try({
          try: () => sharedNativeOwner(records, nativeId),
          catch: failure,
        });
        if (
          store.turnContexts(nativeId).some((value) => value.nativeTurnId === null) ||
          store.uncertainSubmissions(nativeId).length
        )
          return yield* failure(
            new Error("Resolve the previous Desktop send outcome before connecting."),
          );
        const currentSettings = yield* settings.getSettings;
        const provider = currentSettings.providerInstances[owner.providerInstanceId];
        if (!provider || provider.driver !== "codex" || provider.enabled === false)
          return yield* failure(new Error("The original Codex provider is unavailable."));
        const codexConfig = yield* decodeCodexConfig(provider.config ?? {});
        if (
          provider.environment?.some(
            (entry) => entry.name.toUpperCase() === "CODEX_HOME" && typeof entry.value !== "string",
          )
        )
          return yield* failure(
            new Error(
              "An unresolved CODEX_HOME reference prevents verifying this provider's data directory. Use an explicit verified home before connecting.",
            ),
          );
        const env = yield* mergeProviderInstanceEnvironment(provider.environment, environment);
        const layout = yield* resolveCodexHomeLayout(
          !codexConfig.homePath.trim() &&
            !codexConfig.shadowHomePath.trim() &&
            env.CODEX_HOME?.trim()
            ? { ...codexConfig, homePath: env.CODEX_HOME }
            : codexConfig,
        ).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
        const [sourceHome, desktopHome] = yield* Effect.all([
          fs.realPath(layout.sharedHomePath),
          desktop.home.pipe(Effect.flatMap((value) => fs.realPath(value))),
        ]);
        if (
          normalizeProjectPathForComparison(sourceHome) !==
          normalizeProjectPathForComparison(desktopHome)
        )
          return yield* failure(
            new Error("This provider and Codex Desktop use different Codex data directories."),
          );
        const project = yield* projects.getById(records.thread.projectId);
        if (Option.isNone(project) || project.value.archivedAt !== null)
          return yield* failure(new Error("The original project is unavailable."));
        const cwd = records.thread.worktreePath ?? project.value.workspaceRoot;
        const observed: {
          snapshot: DesktopCanonicalSnapshot | null;
          error: Contracts.CodexDesktopError | null;
        } = { snapshot: null, error: null };
        const first = yield* Deferred.make<DesktopCanonicalSnapshot, Contracts.CodexDesktopError>();
        yield* desktop.watchCanonical(nativeId).pipe(
          Stream.runForEach((snapshot) => {
            observed.snapshot = snapshot;
            return snapshot.view.status === "ready" && snapshot.state
              ? Deferred.succeed(first, snapshot).pipe(Effect.asVoid)
              : Effect.void;
          }),
          Effect.catch((cause) => {
            observed.error = failure(cause);
            return Deferred.fail(first, observed.error).pipe(Effect.asVoid);
          }),
          Effect.forkScoped,
        );
        const initialSnapshot = yield* Deferred.await(first).pipe(Effect.timeout("20 seconds"));
        const history = yield* nativeHistory.read({
          providerInstanceId: owner.providerInstanceId,
          nativeThreadId: nativeId,
          cwd,
        });
        const eventPrefix = yield* randomUuidV4;
        yield* sink.withProviderBatch(
          Effect.gen(function* () {
            const current = yield* projections.getThreadRecords(threadId, handoffFields);
            const currentOwner = yield* Effect.try({
              try: () => sharedNativeOwner(current, nativeId),
              catch: failure,
            });
            const currentProject = yield* projects.getById(current.thread.projectId);
            if (
              currentOwner.id !== owner.id ||
              currentOwner.nativeMetadata?.codexSharedRelease?.generation !==
                owner.nativeMetadata?.codexSharedRelease?.generation ||
              current.thread.projectId !== records.thread.projectId ||
              current.thread.worktreePath !== records.thread.worktreePath ||
              Option.isNone(currentProject) ||
              currentProject.value.workspaceRoot !== project.value.workspaceRoot ||
              currentProject.value.archivedAt !== null ||
              !sameProviderConfig(
                (yield* settings.getSettings).providerInstances[owner.providerInstanceId],
                provider,
              )
            )
              return yield* failure(
                new Error("The native binding or workspace changed. Refresh and reconnect."),
              );
            const now = yield* DateTime.now;
            if (observed.error) return yield* observed.error;
            const prepared = yield* Effect.try({
              try: () =>
                sharedNativeHandoffEvents({
                  records: current,
                  nativeId,
                  cwd,
                  snapshot: observed.snapshot ?? initialSnapshot,
                  history,
                  now,
                  eventPrefix,
                }),
              catch: failure,
            });
            // Reserve the private binding first; startup ignores it until the active provider commit exists.
            yield* Effect.try({ try: () => store.bind(binding), catch: failure });
            const committed = yield* sink.writeIfProviderThreadUnchanged({
              expected: currentOwner,
              expectedSharedTitle: {
                title: current.thread.title,
                version: current.thread.codexTitleSync?.version ?? 0,
              },
              events: prepared.events,
            });
            if (!committed.committed)
              return yield* failure(
                new Error("The native owner changed while connecting. Refresh and retry."),
              );
          }),
        );
        yield* startBinding(binding);
        return { threadId, uncertain: store.uncertainSubmissions(nativeId) };
      },
      (effect, threadId) =>
        threadCommands
          .withLock(threadId, Effect.scoped(effect))
          .pipe(bindLock.withPermits(1), Effect.mapError(failure)),
    );
    const exists = yield* fs
      .exists(path.join(config.stateDir, "codex-desktop-sync.sqlite"))
      .pipe(Effect.orElseSucceed(() => false));
    if (exists)
      yield* Effect.gen(function* () {
        const store = yield* persistence.get;
        for (const binding of store.bindings()) yield* startBinding(binding);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not restore shared Desktop bindings", failure(cause)),
        ),
      );
    return { bind, attachExisting, enable: ensureProvider(true).pipe(Effect.mapError(failure)) };
  }),
);
