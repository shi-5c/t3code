import * as Contracts from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { DesktopHistoryLibrary } from "./DesktopHistoryLibrary.ts";
import { DESKTOP_INSTANCE_ID } from "./identity.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadCommands from "../orchestration-v2/ThreadCommandExecutor.ts";
import { codexHistoryEvents } from "../project/codexHistoryEvents.ts";
import { observeSavedTitle } from "./sharedTitle.ts";

const instanceId = Contracts.ProviderInstanceId.make(DESKTOP_INSTANCE_ID);
const fields = [
  "messages",
  "turnItems",
  "providerThreads",
  "providerTurns",
  "runs",
  "runtimeRequests",
] as const;
const decodeThread = Schema.decodeUnknownEffect(Contracts.OrchestrationV2AppThread);
const decodeProvider = Schema.decodeUnknownEffect(Contracts.OrchestrationV2ProviderThread);

/** Materialize saved history without an IPC subscription or a native execution process. */
export const makeDesktopHistoryProjector = Effect.gen(function* () {
  const library = yield* DesktopHistoryLibrary;
  const projects = yield* ProjectService.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const commands = yield* ThreadCommands.ThreadCommandExecutor;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const published = new Map<string, string>();
  const materialize = Effect.fn("DesktopHistoryProjection.materialize")(function* (
    entry: Contracts.CodexDesktopHistoryEntry,
  ) {
    if (entry.fetchedAt === null || entry.attachedToThreadId) return;
    if (!(yield* library.mayProject(entry.sourceId, entry.conversationId))) return;
    // Missing workspaces remain in the durable library and its sidebar. Never create a directory.
    if (
      !entry.cwd ||
      !(yield* fs.stat(entry.cwd).pipe(
        Effect.map((stat) => stat.type === "Directory"),
        Effect.orElseSucceed(() => false),
      ))
    )
      return;
    const key = `${entry.sourceId}:${entry.conversationId}`;
    const fingerprint = stableStringify([
      entry.fetchedAt,
      entry.membership,
      entry.title,
      entry.canonicalTitle,
    ]);
    if (published.get(key) === fingerprint) return;
    const history = yield* library.read(entry.conversationId, entry.sourceId);
    if (!history?.canonical) return;
    const createdAt = DateTime.make(history.canonical.thread.createdAt * 1_000);
    if (Option.isNone(createdAt)) return;
    const completed = new Set(
      history.canonical.turns.filter((turn) => turn.status === "completed").map((turn) => turn.id),
    );
    const savedHistory = {
      ...history,
      ...(history.turnIds ? { turnIds: history.turnIds.filter((id) => completed.has(id)) } : {}),
      messages: history.messages.filter((message) => completed.has(message.turnId)),
    };
    // Missing turn times fall back to thread creation in the reader, never observation time.
    let nativeActivityAt = createdAt.value;
    const activityTimes: Array<string | number> = savedHistory.messages.map(
      (message) => message.createdAt,
    );
    for (const turn of history.canonical.turns) {
      if (!completed.has(turn.id)) continue;
      for (const timestamp of [turn.startedAt, turn.completedAt])
        if (typeof timestamp === "number" && Number.isFinite(timestamp))
          activityTimes.push(timestamp * 1_000);
    }
    for (const timestamp of activityTimes) {
      const observed = DateTime.make(timestamp);
      if (Option.isSome(observed) && DateTime.isGreaterThan(observed.value, nativeActivityAt))
        nativeActivityAt = observed.value;
    }
    const threadId = Contracts.ThreadId.make(`codex-desktop:${entry.conversationId}`);
    const original = yield* projections
      .getThreadRecords(threadId, fields)
      .pipe(
        Effect.asSome,
        Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeedNone }),
      );
    if (
      Option.isSome(original) &&
      (original.value.thread.deletedAt !== null ||
        original.value.thread.codexDesktopHistory?.sourceId !== entry.sourceId)
    )
      return;
    const now = yield* DateTime.now;
    const origin = {
      sourceId: entry.sourceId,
      nativeId: entry.conversationId,
      membership: entry.membership,
      attachedToThreadId: entry.attachedToThreadId ?? null,
      fetchedAt: entry.fetchedAt,
    };
    if (Option.isNone(original)) {
      const owner = yield* projections.findNativeThreadOwner({
        driver: Contracts.ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        nativeThreadId: entry.conversationId,
        scope: "all",
      });
      if (owner !== null) return;
      if (!(yield* library.mayProject(entry.sourceId, entry.conversationId))) return;
      const existingProject = yield* projects.getByWorkspaceRoot(entry.cwd);
      const project = Option.isSome(existingProject)
        ? existingProject.value
        : yield* projects.create({
            commandId: Contracts.CommandId.make(
              `desktop-history-project:${entry.sourceId}:${entry.conversationId}`,
            ),
            projectId: Contracts.ProjectId.make(
              `desktop-history-workspace:${entry.sourceId}:${entry.conversationId}`,
            ),
            title: path.basename(entry.cwd) || "Codex workspace",
            workspaceRoot: entry.cwd,
            defaultThreadType: "codex-shared",
          });
      if (project.archivedAt !== null) return;
      const providerThreadId = Contracts.ProviderThreadId.make(
        `desktop-provider-thread:${entry.conversationId}`,
      );
      const native = history.canonical.thread;
      const selection = {
        instanceId,
        model: typeof native.model === "string" && native.model ? native.model : "unknown",
      };
      const thread = yield* decodeThread({
        id: threadId,
        projectId: project.id,
        title: entry.title,
        threadType: "codex-shared",
        codexSharedOwner: "desktop",
        codexDesktopHistory: origin,
        providerInstanceId: instanceId,
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThreadId,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "system",
        creationSource: "server",
        createdAt: createdAt.value,
        updatedAt: nativeActivityAt,
        archivedAt: entry.archived ? now : null,
        deletedAt: null,
      });
      const providerThread = yield* decodeProvider({
        id: providerThreadId,
        driver: "codex",
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver: "codex", nativeId: entry.conversationId, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        nativeMetadata: {
          codexDesktopHandoff: { sourceProviderThreadId: providerThreadId, baselineTurnIds: [] },
        },
        createdAt: createdAt.value,
        updatedAt: nativeActivityAt,
      });
      if (!(yield* library.mayProject(entry.sourceId, entry.conversationId))) return;
      yield* sink.write({
        unlessNativeThreadOwned: { ...providerThread, anyProviderInstance: true },
        events: [
          {
            id: Contracts.EventId.make(`desktop-history-thread:${key}`),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
          {
            id: Contracts.EventId.make(`desktop-history-provider:${key}`),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: providerThread,
          },
          {
            id: Contracts.EventId.make(`desktop-history-metadata:${key}`),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
    }
    const committed = yield* commands.withLock(
      threadId,
      sink.withProviderBatch(
        Effect.gen(function* () {
          if (!(yield* library.mayProject(entry.sourceId, entry.conversationId))) return;
          const current = yield* projections.getThreadRecords(threadId, fields);
          if (
            current.thread.deletedAt !== null ||
            current.thread.codexDesktopHistory?.sourceId !== entry.sourceId ||
            current.thread.providerInstanceId !== instanceId ||
            Contracts.codexSharedOwnerOf(current.thread) !== "desktop" ||
            current.runtimeRequests.some((request) => request.status === "pending") ||
            current.runs.some((run) =>
              ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
            )
          )
            return;
          const provider = current.providerThreads.find(
            (row) => row.id === current.thread.activeProviderThreadId,
          );
          if (provider?.nativeThreadRef?.nativeId !== entry.conversationId) return;
          const local = new Set(current.providerTurns.map((turn) => turn.nativeTurnRef?.nativeId));
          const baseline = new Set(
            provider.nativeMetadata?.codexDesktopHandoff?.baselineTurnIds ?? [],
          );
          for (const id of completed) if (!local.has(id)) baseline.add(id);
          const prefix = `desktop-cache:${yield* randomUuidV4}`;
          const events = [
            ...(yield* Effect.try({
              try: () => codexHistoryEvents(savedHistory, provider, current, now, prefix, "native"),
              catch: () =>
                new Contracts.CodexDesktopError({
                  message: "Saved history changed; the existing timeline is preserved.",
                  outcomeUnknown: false,
                }),
            })),
          ];
          const activityAt = DateTime.max(current.thread.updatedAt, nativeActivityAt);
          const metadata = {
            ...current.thread,
            codexDesktopHistory: origin,
            updatedAt: activityAt,
          };
          if (!current.thread.codexTitleSync) metadata.title = entry.title;
          else if (entry.canonicalTitle?.name === history.canonical!.thread.name) {
            const prior = Option.isSome(original) ? original.value.thread : undefined;
            Object.assign(
              metadata,
              observeSavedTitle(
                current.thread,
                entry,
                prior?.title === current.thread.title &&
                  prior.codexSharedOwner === current.thread.codexSharedOwner &&
                  stableStringify(prior.codexTitleSync) ===
                    stableStringify(current.thread.codexTitleSync),
                (!provider.nativeMetadata?.codexNativeTitle ||
                  provider.nativeMetadata.codexNativeTitle.status === "saved") &&
                  (!provider.nativeMetadata?.codexSharedRelease ||
                    provider.nativeMetadata.codexSharedRelease.state === "ready"),
              ),
            );
          }
          events.push(
            {
              id: Contracts.EventId.make(`${prefix}:baseline`),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...provider,
                nativeMetadata: {
                  ...provider.nativeMetadata,
                  codexDesktopHandoff: {
                    sourceProviderThreadId: provider.id,
                    baselineTurnIds: [...baseline],
                  },
                },
                updatedAt: activityAt,
              },
            },
            // The provider event also touches thread activity; finalize it from native/local activity.
            {
              id: Contracts.EventId.make(`${prefix}:metadata`),
              type: "thread.metadata-updated",
              threadId,
              occurredAt: now,
              payload: metadata,
            },
          );
          yield* sink.write({ events });
          return true;
        }),
      ),
    );
    if (committed) published.set(key, fingerprint);
  }, library.withProjection);
  return materialize;
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const library = yield* DesktopHistoryLibrary;
    const materialize = yield* makeDesktopHistoryProjector;
    const tick = Effect.gen(function* () {
      for (const entry of yield* library.list)
        yield* materialize(entry).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Desktop history projection is pending", {
              nativeId: entry.conversationId,
              cause,
            }),
          ),
        );
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Desktop history projection is unavailable", { cause }),
      ),
    );
    yield* forkParked(tick.pipe(Effect.andThen(Effect.sleep("15 seconds")), Effect.forever));
  }),
);
