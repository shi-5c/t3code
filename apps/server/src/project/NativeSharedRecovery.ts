import { codexSharedOwnerOf } from "@t3tools/contracts";
import { AgentSessionScanError, type ThreadId, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import type * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
const isAgentSessionScanError = Schema.is(AgentSessionScanError);

/** Explicit reconciliation only: resume the saved ID and confirm release without starting a turn. */
export const recoverSharedNativeRelease = Effect.fn("NativeSharedRecovery.release")(
  function* (input: {
    threadId: ThreadId;
    projectId: ProjectId;
    projections: ProjectionStore.ProjectionStoreV2["Service"];
    sessions: ProviderSessionManager.ProviderSessionManagerV2["Service"];
    runtimePolicy: RuntimePolicy.RuntimePolicyV2["Service"];
    eventSink: EventSink.EventSinkV2["Service"];
    idAllocator: IdAllocator.IdAllocatorV2["Service"];
  }) {
    const records = yield* input.projections.getThreadRecords(input.threadId, [
      "providerThreads",
      "providerSessions",
      "runs",
      "runtimeRequests",
    ]);
    let owner = records.providerThreads.find(
      (thread) => thread.id === records.thread.activeProviderThreadId,
    );
    const refuse = (detail: string) =>
      new AgentSessionScanError({ operation: "read-projects", cause: detail, detail });
    if (
      records.thread.threadType !== "codex-shared" ||
      records.thread.projectId !== input.projectId ||
      records.thread.deletedAt !== null ||
      records.thread.archivedAt !== null ||
      owner?.driver !== "codex" ||
      codexSharedOwnerOf(records.thread) !== "native" ||
      owner.providerInstanceId !== records.thread.modelSelection.instanceId
    )
      return yield* refuse(
        "Select an active shared conversation with its original Codex provider.",
      );
    const nativeId = owner.nativeThreadRef?.nativeId;
    if (!nativeId || owner.nativeMetadata?.codexSharedCreationPending)
      return yield* refuse(
        "Creation is unconfirmed. Find the conversation in Codex and connect that existing conversation; do not resend the first message.",
      );
    if (
      records.runs.some((run) =>
        ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
      ) ||
      records.runtimeRequests.some((request) => request.status === "pending") ||
      (owner.pendingBackgroundTasks?.length ?? 0) > 0
    )
      return yield* refuse(
        "Finish or stop the existing work and resolve its requests before checking release.",
      );
    const policy = yield* input.runtimePolicy.resolve({
      thread: records.thread,
      modelSelection: records.thread.modelSelection,
    });
    const providerSessionId =
      owner.providerSessionId ??
      (owner.providerInstanceId === "codex-desktop"
        ? yield* input.idAllocator.allocate.providerSession({
            providerInstanceId: owner.providerInstanceId,
            threadId: input.threadId,
          })
        : input.idAllocator.derive.providerSession({
            providerInstanceId: owner.providerInstanceId,
          }));
    if (owner.providerSessionId === null) {
      const now = yield* DateTime.now;
      const eventId = yield* input.idAllocator.allocate.event({ threadId: input.threadId });
      const attached = {
        ...owner,
        providerSessionId,
        updatedAt: now,
        nativeMetadata: {
          ...owner.nativeMetadata,
          codexShared: true as const,
          codexSharedRelease: { state: "unknown" as const, nativeId, generation: String(eventId) },
        },
      };
      const committed = yield* input.eventSink.writeIfProviderThreadUnchanged({
        expected: owner,
        events: [
          {
            id: eventId,
            type: "provider-thread.updated",
            threadId: input.threadId,
            occurredAt: now,
            payload: attached,
          },
        ],
      });
      if (!committed.committed)
        return yield* refuse(
          "The native binding changed. Refresh this conversation before checking release again.",
        );
      owner = attached;
    }
    const existingSession = records.providerSessions.find(
      (session) => session.id === providerSessionId,
    );
    const session = yield* input.sessions.open({
      threadId: input.threadId,
      providerSessionId,
      modelSelection: records.thread.modelSelection,
      runtimePolicy: policy,
      initialNativeThreadId: nativeId,
      ...(existingSession ? { resumeFromSession: existingSession } : {}),
    });
    // No ensureThread, fallback, unarchive, prompt or turn replay is permitted here.
    const resumed = yield* session.resumeThread({
      threadId: input.threadId,
      providerThread: {
        ...owner,
        providerSessionId,
        nativeMetadata: { ...owner.nativeMetadata, codexShared: true },
      },
      modelSelection: records.thread.modelSelection,
      runtimePolicy: policy,
    });
    if (resumed.nativeThreadRef?.nativeId !== nativeId)
      return yield* refuse(
        "Codex returned a different native conversation. Release recovery stopped.",
      );
    yield* input.sessions.releaseSharedThread({ providerSessionId, threadId: input.threadId });
  },
  (effect) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isAgentSessionScanError(cause)
          ? cause
          : new AgentSessionScanError({
              operation: "read-projects",
              cause,
              detail:
                "Release is still unconfirmed. Close this conversation in the other Codex client, let its work finish, then check release again. No message was sent.",
            }),
      ),
    ),
);
