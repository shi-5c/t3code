import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  isRuntimeModeAbove,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";
import * as CodexSessionHistory from "./CodexSessionHistory.ts";
import { refreshSharedNativeHistory } from "./NativeSharedHistory.ts";
import { codexHistoryEvents } from "./codexHistoryEvents.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";

class AgentSessionHomeAmbiguousError extends Schema.TaggedError<AgentSessionHomeAmbiguousError>()(
  "AgentSessionHomeAmbiguousError",
  { nativeThreadId: Schema.String },
) {
  override get message() {
    return "This native Codex ID is already tracked by another provider whose original home is unverified. Keep that conversation or explicitly reconcile its home before importing another copy.";
  }
}
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const codexHistory = yield* CodexSessionHistory.CodexSessionHistory;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;
  const unchangedNativeCursor = new Map<ProjectId, string>();
  const changedNativeCursor = new Map<ProjectId, string>();
  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    if (input.threadId !== undefined) {
      if (input.reconcileRelease)
        yield* orchestrator.reconcileSharedRelease(input.threadId, input.projectId);
      return yield* refreshSharedNativeHistory({
        threadId: input.threadId,
        projectId: input.projectId,
        workspaceRoot: project.workspaceRoot,
        projections,
        eventSink,
        history: codexHistory,
      });
    }
    // Imports run in full access, except under a policy ceiling: then in the project's default,
    // which the policy keeps under it, so imported threads never sit above the ceiling.
    const runtimeMode =
      ceiling === undefined
        ? DEFAULT_RUNTIME_MODE
        : yield* settingsService.getSettings.pipe(
            Effect.mapError(
              (cause) => new AgentSessionScanError({ operation: "read-settings", cause }),
            ),
            Effect.map((settings) => {
              const mode = resolveProjectSettings(settings, input.projectId, project).settings
                .defaultRuntimeMode;
              return isRuntimeModeAbove(mode, ceiling) ? ceiling : mode;
            }),
          );
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
    const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources, true);
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;
    let nativeReadsRemaining = 100;

    const processOutcome = Effect.fn("AgentSessionImporter.importOutcome")(function* (
      outcome: AgentSessionScanner.AgentSessionRecentThread,
    ) {
      if (outcome._tag === "Skipped") {
        skippedCount += 1;
        return;
      }
      const source = outcome.source;
      if (input.discoverOnly && source.provider !== "codex") return;
      if (
        input.discoverOnly &&
        (yield* projections
          .findNativeThreadOwner({
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: source.providerInstanceId,
            nativeThreadId: source.providerSessionId,
          })
          .pipe(
            Effect.mapError(
              (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
            ),
          )) !== null
      )
        return;
      let threadId = ThreadId.make(
        `import:${source.providerInstanceId}:${source.providerSessionId}`,
      );
      if (outcome._tag === "AlreadyImported" && source.provider !== "codex") {
        importedThreadIds.add(threadId);
        importedCount += 1;
        return;
      }
      if (outcome._tag === "Duplicate") {
        if (importedThreadIds.has(threadId)) {
          yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
        }
        return;
      }
      if (
        source.provider === "codex" &&
        outcome._tag !== "AlreadyImported" &&
        nativeReadsRemaining-- <= 0
      ) {
        skippedCount += 1;
        return;
      }

      const imported = yield* Effect.gen(function* () {
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        // An unchanged rollout is not proof that the independent reader saw all persisted items.
        const thread: AgentSessionScanner.AgentSessionThread =
          outcome._tag === "Importable"
            ? outcome.thread
            : {
                source: source.provider,
                providerInstanceId: source.providerInstanceId,
                providerSessionId: source.providerSessionId,
                title: source.providerSessionId,
                model: null,
                createdAt: observedAt,
                updatedAt: observedAt,
                messages: [],
                omittedMessageCount: 0,
              };
        const eventPrefix = yield* randomUuidV4;
        const nativeHistory =
          thread.source === "codex"
            ? yield* codexHistory.read({
                providerInstanceId: thread.providerInstanceId,
                nativeThreadId: thread.providerSessionId,
                cwd: project.workspaceRoot,
              })
            : null;
        return yield* eventSink.withProviderBatch(
          Effect.gen(function* () {
            if (
              thread.source === "claudeAgent" &&
              !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
            ) {
              return yield* new AgentSessionUnresumableSessionError({
                source: thread.source,
                providerSessionId: thread.providerSessionId,
              });
            }
            const driver = ProviderDriverKind.make(thread.source);
            // Pi resumes by session file path; its session UUID only names the thread.
            const nativeThreadId =
              thread.source === "pi" ? source.filePath : thread.providerSessionId;
            const nativeOwner = nativeHistory
              ? yield* projections.findNativeThreadOwner({
                  driver,
                  providerInstanceId: thread.providerInstanceId,
                  nativeThreadId,
                })
              : null;
            if (nativeHistory) {
              // A changed/disabled provider configuration cannot establish the home
              // of an old thread. Fail closed on collisions instead of merging accounts.
              const ambiguousOwner = yield* projections.findNativeThreadOwner({
                driver,
                providerInstanceId: thread.providerInstanceId,
                nativeThreadId,
                scope:
                  nativeOwner === null && project.defaultThreadType === "codex-shared"
                    ? "all"
                    : "shared",
                ...(nativeOwner === null ? {} : { excludeThreadId: nativeOwner }),
              });
              if (ambiguousOwner !== null)
                return yield* new AgentSessionHomeAmbiguousError({ nativeThreadId });
            }
            if (input.discoverOnly) {
              const latestProject = yield* projects.getById(input.projectId);
              if (
                nativeOwner !== null ||
                Option.isNone(latestProject) ||
                latestProject.value.defaultThreadType !== "codex-shared" ||
                latestProject.value.deletedAt !== null ||
                latestProject.value.archivedAt != null ||
                normalizeProjectPathForComparison(latestProject.value.workspaceRoot) !==
                  normalizeProjectPathForComparison(project.workspaceRoot)
              )
                return null;
            }
            // Preserve the existing provider and owner when another configured instance
            // discovers the same history. Explicit handoff is the only owner transition.
            if (
              nativeOwner !== null &&
              (yield* projections.getThread(nativeOwner)).providerInstanceId !==
                thread.providerInstanceId
            )
              return null;
            threadId = nativeOwner ?? threadId;
            if (outcome._tag === "AlreadyImported" && nativeOwner === null) return null;
            const persistRuntime = runtimes.upsert(
              {
                threadId,
                providerName: driver,
                providerInstanceId: thread.providerInstanceId,
                adapterKey: driver,
                runtimeMode,
                status: "stopped",
                lastSeenAt: thread.updatedAt,
                resumeCursor:
                  thread.source === "claudeAgent"
                    ? { threadId, resume: thread.providerSessionId }
                    : { threadId: nativeThreadId },
                runtimePayload: { cwd: project.workspaceRoot },
              },
              { onConflict: "ignore" },
            );
            const readExisting = orchestrator.getThreadRecords(threadId, [
              "messages",
              "turnItems",
              "providerTurns",
              "providerThreads",
              "runs",
              "runtimeRequests",
            ]);
            const existing = yield* nativeOwner === null
              ? Effect.option(readExisting)
              : readExisting.pipe(Effect.asSome);
            if (Option.isSome(existing)) {
              if (input.discoverOnly) return null;
              if (
                nativeHistory &&
                (existing.value.thread.archivedAt !== null ||
                  existing.value.thread.deletedAt !== null)
              )
                return null;
              if (existing.value.thread.projectId !== input.projectId) {
                return yield* new AgentSessionThreadProjectConflictError({
                  threadId,
                  expectedProjectId: input.projectId,
                  actualProjectId: existing.value.thread.projectId,
                });
              }
              if (nativeHistory) {
                const owner = existing.value.providerThreads.find(
                  (value) =>
                    value.nativeThreadRef?.nativeId === nativeThreadId &&
                    value.providerInstanceId === thread.providerInstanceId,
                );
                if (!owner) return yield* new AgentSessionThreadModifiedError({ threadId });
                if (existing.value.runtimeRequests.some((request) => request.status === "pending"))
                  return false;
                const events = yield* Effect.try({
                  try: () =>
                    codexHistoryEvents(
                      nativeHistory,
                      owner,
                      existing.value,
                      dateTime(thread.updatedAt),
                      eventPrefix,
                    ),
                  catch: (cause) =>
                    new CodexSessionHistory.CodexSessionHistoryError({ nativeThreadId, cause }),
                });
                yield* eventSink.write({ events });
                if (existing.value.thread.historyOrigin === "v1_import") yield* persistRuntime;
                yield* runtimes.recordImportedTranscript({ threadId, source });
                return true;
              }
              if (existing.value.thread.historyOrigin !== "v1_import") {
                return yield* new AgentSessionThreadModifiedError({ threadId });
              }
              yield* persistRuntime;
              yield* runtimes.recordImportedTranscript({ threadId, source });
              return true;
            }

            // A discovered disk ID is not an existing T3 binding. Shared admission belongs to the reserved Desktop connector.
            if (thread.source === "codex" && project.defaultThreadType === "codex-shared")
              return false;
            const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
            const providerThreadId = idAllocator.derive.providerThread({
              driver,
              providerInstanceId: thread.providerInstanceId,
              nativeThreadId,
            });
            const createdAt = dateTime(thread.createdAt);
            const updatedAt = dateTime(thread.updatedAt);
            const appThread: OrchestrationV2AppThread = {
              createdBy: "system",
              creationSource: "server",
              id: threadId,
              projectId: input.projectId,
              title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
              providerInstanceId: thread.providerInstanceId,
              modelSelection: { instanceId: thread.providerInstanceId, model },
              runtimeMode,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: null,
              worktreePath: null,
              linkedPullRequest: null,
              branchPullRequest: null,
              activeProviderThreadId: providerThreadId,
              historyOrigin: "v1_import",
              lineage: {
                parentThreadId: null,
                relationshipToParent: null,
                rootThreadId: threadId,
              },
              forkedFrom: null,
              createdAt,
              updatedAt,
              archivedAt: null,
              settledOverride: "settled",
              settledAt: updatedAt,
              unsettledAt: null,
              snoozedUntil: null,
              snoozedAt: null,
              pinnedAt: null,
              pinOrderKey: null,
              activeOrderKey: null,
              lastVisitedAt: null,
              deletedAt: null,
            };
            const providerThread: OrchestrationV2ProviderThread = {
              id: providerThreadId,
              driver,
              providerInstanceId: thread.providerInstanceId,
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: nativeThreadId,
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              createdAt,
              updatedAt,
            };

            const committed = yield* eventSink.write({
              unlessNativeThreadOwned: providerThread,
              events: [
                {
                  id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                  type: "thread.created",
                  threadId,
                  providerInstanceId: thread.providerInstanceId,
                  occurredAt: createdAt,
                  payload: appThread,
                },
                ...(!nativeHistory && thread.omittedMessageCount > 0
                  ? [
                      {
                        id: EventId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
                        type: "turn-item.updated" as const,
                        threadId,
                        occurredAt: createdAt,
                        payload: {
                          id: TurnItemId.make(
                            `${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`,
                          ),
                          threadId,
                          runId: null,
                          nodeId: null,
                          providerThreadId: null,
                          providerTurnId: null,
                          nativeItemRef: null,
                          parentItemId: null,
                          ordinal: 0,
                          status: "completed" as const,
                          title: null,
                          startedAt: createdAt,
                          completedAt: createdAt,
                          updatedAt: createdAt,
                          type: "system_notice" as const,
                          message: `${thread.omittedMessageCount} earlier ${thread.omittedMessageCount === 1 ? "message was" : "messages were"} not imported. This thread keeps the first user message and the most recent history. The original session transcript is unchanged.`,
                        },
                      },
                    ]
                  : []),
                ...(nativeHistory
                  ? yield* Effect.try({
                      try: () =>
                        codexHistoryEvents(
                          nativeHistory,
                          providerThread,
                          {
                            thread: appThread,
                            messages: [],
                            turnItems: [],
                            providerTurns: [],
                            runs: [],
                          },
                          updatedAt,
                          eventPrefix,
                        ),
                      catch: (cause) =>
                        new CodexSessionHistory.CodexSessionHistoryError({
                          nativeThreadId,
                          cause,
                        }),
                    })
                  : thread.messages.flatMap((message, index) =>
                      messageEvents({ threadId, index, message }),
                    )),
                {
                  id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                  type: "provider-thread.updated",
                  threadId,
                  driver,
                  providerInstanceId: thread.providerInstanceId,
                  occurredAt: updatedAt,
                  payload: providerThread,
                },
              ],
            });
            if (committed.length === 0) return null;
            yield* persistRuntime;
            yield* runtimes.recordImportedTranscript({ threadId, source });
            return true;
          }),
        );
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not import an agent session", {
            provider: source.provider,
            sessionId: source.providerSessionId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (imported === true) {
        importedThreadIds.add(threadId);
        importedCount += 1;
      } else if (imported === false) {
        skippedCount += 1;
      }
    });

    const unchanged = new Map<
      string,
      Extract<AgentSessionScanner.AgentSessionRecentThread, { readonly _tag: "AlreadyImported" }>
    >();
    const changed = new Map<string, AgentSessionScanner.AgentSessionRecentThread>();
    yield* Stream.runForEach(outcomes, (outcome) => {
      if (!("source" in outcome)) return processOutcome(outcome);
      if (input.discoverOnly) {
        if (outcome.source.provider === "codex" && outcome._tag !== "AlreadyImported")
          changed.set(
            `${outcome.source.providerInstanceId}\0${outcome.source.providerSessionId}`,
            outcome,
          );
        return Effect.void;
      }
      if (outcome._tag !== "AlreadyImported" || outcome.source.provider !== "codex")
        return processOutcome(outcome);
      if (input.discoverOnly) return Effect.void;
      unchanged.set(
        `${outcome.source.providerInstanceId}\0${outcome.source.providerSessionId}`,
        outcome,
      );
      return Effect.void;
    });
    if (input.discoverOnly) {
      const ordered = [...changed.entries()].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      const cursor = changedNativeCursor.get(input.projectId);
      const start = Math.max(
        0,
        cursor === undefined ? 0 : ordered.findIndex(([key]) => key > cursor),
      );
      const selected = [...ordered.slice(start), ...ordered.slice(0, start)].slice(0, 10);
      for (const [key, outcome] of selected) {
        yield* processOutcome(outcome);
        changedNativeCursor.set(input.projectId, key);
      }
      skippedCount += ordered.length - selected.length;
    }
    // New files get their own budget; rotate unchanged reads so old partial snapshots also progress.
    const ordered = [...unchanged.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const cursor = unchangedNativeCursor.get(input.projectId);
    const next = cursor === undefined ? 0 : ordered.findIndex(([key]) => key > cursor);
    const start = Math.max(0, next);
    const selected = [...ordered.slice(start), ...ordered.slice(0, start)].slice(0, 100);
    for (const [key, outcome] of selected) {
      yield* processOutcome(outcome);
      unchangedNativeCursor.set(input.projectId, key);
    }
    skippedCount += ordered.length - selected.length;

    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  return { importRecentAgentThreads };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
