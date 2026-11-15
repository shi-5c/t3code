import { codexSharedOwnerOf } from "@t3tools/contracts";
import {
  AgentSessionScanError,
  type ProjectId,
  type ThreadId,
  type RunId,
  type RunAttemptId,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as CodexSessionHistory from "./CodexSessionHistory.ts";
import { codexHistoryEvents } from "./codexHistoryEvents.ts";

/** The caller holds the thread dispatch lock for a send; native I/O stays outside SQL. */
export const refreshSharedNativeHistory = Effect.fn("NativeSharedHistory.refresh")(
  function* (input: {
    threadId: ThreadId;
    projectId: ProjectId;
    workspaceRoot: string | null;
    projections: ProjectionStore.ProjectionStoreV2["Service"];
    eventSink: EventSink.EventSinkV2["Service"];
    history: CodexSessionHistory.CodexSessionHistory["Service"] | undefined;
    beforeSend?: boolean;
    startingRun?: { id: RunId; attemptId: RunAttemptId };
  }) {
    const { threadId, projections, eventSink } = input;
    const fields = [
      "messages",
      "turnItems",
      "providerTurns",
      "providerThreads",
      "runs",
      "runtimeRequests",
    ] as const;
    const records = yield* projections.getThreadRecords(threadId, fields);
    const refuse = (cause: string) =>
      new AgentSessionScanError({ operation: "read-projects", cause });
    const skipped = { importedCount: 0, skippedCount: 1 };
    if (
      records.thread.projectId !== input.projectId ||
      records.thread.threadType !== "codex-shared"
    )
      return yield* refuse("The selected conversation is not a shared thread in this project.");
    const owner = records.providerThreads.find(
      (thread) => thread.id === records.thread.activeProviderThreadId,
    );
    if (
      input.beforeSend &&
      (owner?.nativeMetadata?.codexSharedCreationPending ||
        ["pending", "unknown"].includes(owner?.nativeMetadata?.codexSharedRelease?.state ?? ""))
    )
      return yield* refuse(
        "Native creation or release is not confirmed. Wait for a confirmed release before sending.",
      );
    const activeRuns = (value: typeof records) =>
      value.runs.filter(
        (run) =>
          input.startingRun === undefined ||
          (run.status !== "queued" &&
            run.status !== "preparing" &&
            run.id !== input.startingRun.id),
      );
    const currentAttempt = (value: typeof records) =>
      input.startingRun === undefined ||
      value.runs.some(
        (run) =>
          run.id === input.startingRun?.id &&
          run.status === "starting" &&
          run.activeAttemptId === input.startingRun.attemptId,
      );
    const protectedWork = (value: typeof records) =>
      !currentAttempt(value) ||
      value.thread.archivedAt !== null ||
      value.thread.deletedAt !== null ||
      value.runtimeRequests.some((request) => request.status === "pending") ||
      activeRuns(value).some((run) =>
        ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
      );
    if (protectedWork(records)) {
      if (input.startingRun)
        return yield* refuse(
          "Shared history refresh is blocked by active work or a changed attempt.",
        );
      return skipped;
    }
    if (
      !owner?.nativeThreadRef ||
      owner.driver !== "codex" ||
      codexSharedOwnerOf(records.thread) !== "native"
    )
      return skipped;
    if (!input.history)
      return yield* refuse("Native shared history is unavailable on this server.");
    const nativeId = owner.nativeThreadRef.nativeId;
    if (!nativeId || !(records.thread.worktreePath ?? input.workspaceRoot))
      return yield* refuse("Native identity or workspace is unavailable.");
    const history = yield* input.history.read({
      providerInstanceId: owner.providerInstanceId,
      nativeThreadId: nativeId,
      cwd: (records.thread.worktreePath ?? input.workspaceRoot)!,
    });
    const prefix = yield* randomUuidV4;
    return yield* eventSink.withProviderBatch(
      Effect.gen(function* () {
        const current = yield* projections.getThreadRecords(threadId, fields);
        const currentOwner = current.providerThreads.find(
          (thread) => thread.id === current.thread.activeProviderThreadId,
        );
        if (
          current.thread.projectId !== input.projectId ||
          current.thread.threadType !== "codex-shared" ||
          currentOwner?.id !== owner.id ||
          currentOwner.providerInstanceId !== owner.providerInstanceId ||
          currentOwner.nativeThreadRef?.nativeId !== nativeId
        )
          return yield* refuse("The native binding changed during history refresh.");
        if (
          protectedWork(current) ||
          DateTime.toEpochMillis(currentOwner.updatedAt) !== DateTime.toEpochMillis(owner.updatedAt)
        ) {
          if (input.beforeSend)
            return yield* refuse(
              "The conversation changed during refresh. Review the latest state and retry.",
            );
          return skipped;
        }
        const now = yield* DateTime.now;
        const events = yield* Effect.try({
          try: () =>
            codexHistoryEvents(
              history,
              currentOwner,
              { ...current, runs: activeRuns(current) },
              now,
              prefix,
            ),
          catch: (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        });
        yield* eventSink.write({ events });
        return { importedCount: 1, skippedCount: 0 };
      }),
    );
  },
  (effect) =>
    effect.pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    ),
);
