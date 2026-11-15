import { observeSharedTitle } from "./sharedTitle.ts";
import * as Contracts from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import type { ProjectionRecords } from "../orchestration-v2/ProjectionStore.ts";
import type { CodexHistory } from "../project/CodexSessionHistory.ts";
import { codexHistoryEvents } from "../project/codexHistoryEvents.ts";
import type { DesktopCanonicalSnapshot } from "./CodexDesktop.ts";
import { DESKTOP_INSTANCE_ID } from "./identity.ts";
import { list, record, string } from "./protocol.ts";
import { desktopModelSelection, SharedDesktopHistory } from "./sharedProjection.ts";

export const handoffFields = [
  "providerThreads",
  "runs",
  "runtimeRequests",
  "messages",
  "turnItems",
  "providerTurns",
] as const;
type HandoffRecords = ProjectionRecords<(typeof handoffFields)[number]>;

export function sharedNativeOwner(records: HandoffRecords, nativeId: string) {
  const { thread } = records;
  const owner = records.providerThreads.find((value) => value.id === thread.activeProviderThreadId);
  if (
    thread.threadType !== "codex-shared" ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    !owner ||
    owner.driver !== "codex" ||
    Contracts.codexSharedOwnerOf(thread) !== "native" ||
    owner.providerInstanceId !== thread.providerInstanceId ||
    owner.providerInstanceId !== thread.modelSelection.instanceId ||
    owner.nativeThreadRef?.nativeId !== nativeId ||
    owner.nativeThreadRef.strength !== "strong"
  )
    throw new Error("Select the original active shared conversation and its saved native ID.");
  const release = owner.nativeMetadata?.codexSharedRelease;
  const titleState = Contracts.nativeTitleHandoffState({
    title: thread.title,
    titleVersion: thread.codexTitleSync?.version ?? 0,
    titleSource: thread.codexTitleSync?.source,
    preparation: owner.nativeMetadata?.codexNativeTitle,
  });
  if (titleState === "unconfirmed")
    throw new Error(
      "A native title write is unconfirmed. Check release to reconcile it before connecting to Desktop.",
    );
  if (titleState === "stale")
    throw new Error(
      "The T3 title changed after native release. Check release before connecting to Desktop.",
    );
  if (
    owner.nativeMetadata?.codexSharedCreationPending ||
    release?.state !== "ready" ||
    release.nativeId !== nativeId
  )
    throw new Error("Confirm native release before connecting this conversation to Desktop.");
  if (
    records.runs.some((run) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    ) ||
    records.runtimeRequests.some((request) => request.status === "pending") ||
    (owner.pendingBackgroundTasks?.length ?? 0) > 0
  )
    throw new Error(
      "Finish queued work, approvals and background tasks before connecting to Desktop.",
    );
  return owner;
}

/** Preserve native artifacts; the Desktop owner projects only turns after this complete idle baseline. */
export function sharedNativeHandoffEvents(input: {
  records: HandoffRecords;
  nativeId: string;
  cwd: string;
  snapshot: DesktopCanonicalSnapshot;
  history: CodexHistory;
  now: DateTime.Utc;
  eventPrefix: string;
}) {
  const { records, nativeId, snapshot, history, now, eventPrefix } = input;
  const owner = sharedNativeOwner(records, nativeId);
  if (
    snapshot.view.conversationId !== nativeId ||
    snapshot.view.status !== "ready" ||
    !snapshot.state ||
    snapshot.view.activeTurnId !== null ||
    snapshot.view.pendingRequests !== 0 ||
    list(snapshot.state.requests).length > 0 ||
    record(snapshot.state.threadRuntimeStatus).type !== "idle"
  )
    throw new Error(
      "Open this conversation in Codex Desktop and wait until its work and requests finish.",
    );
  if (
    normalizeProjectPathForComparison(input.cwd) !==
    normalizeProjectPathForComparison(snapshot.view.cwd)
  )
    throw new Error("Desktop and T3 must use the same workspace for this native conversation.");
  const baseline = new SharedDesktopHistory();
  const turns = baseline.merge(snapshot.state);
  const turnIds = turns.map((turn) => string(turn.turnId));
  if (
    !baseline.ready ||
    turns.some(
      (turn) =>
        !["completed", "interrupted", "failed", "error", "cancelled"].includes(string(turn.status)),
    ) ||
    history.nativeThreadId !== nativeId ||
    !history.turnIds ||
    JSON.stringify(turnIds) !== JSON.stringify(history.turnIds) ||
    records.providerTurns.some(
      (turn) =>
        turn.providerThreadId === owner.id &&
        turn.nativeTurnRef?.nativeId &&
        !turnIds.includes(turn.nativeTurnRef.nativeId),
    )
  )
    throw new Error(
      "Desktop and saved history have not reached the same complete idle baseline. Refresh and retry.",
    );
  const visible = new Map<string, { role: "user" | "assistant"; text: string }>();
  if (history.omittedItemTypes.includes("userMessage attachment"))
    throw new Error(
      "Connecting a native conversation with input attachments is not supported yet. Its saved history remains available.",
    );
  const identity = (turnId: string, itemId: string) => JSON.stringify([turnId, itemId]);
  const incomplete = () =>
    new Error("Desktop and saved user/assistant text do not match yet. Wait and retry connecting.");
  for (const turn of turns) {
    const items = list(turn.items).map(record);
    if (record(turn.params).toolOutput !== undefined)
      throw new Error(
        "Connecting a native conversation with app-tool inputs is not supported yet. Its saved history remains available.",
      );
    // Optimistic input has no durable item identity until its canonical user item arrives.
    if (
      !items.some((item) => item.type === "userMessage") &&
      list(record(turn.params).input).length > 0
    )
      throw incomplete();
    for (const item of items) {
      if (item.type === "steeringUserMessage")
        throw new Error(
          "Connecting a native conversation with steering inputs is not supported yet. Its saved history remains available.",
        );
      if (!["agentMessage", "userMessage", "steeringUserMessage"].includes(string(item.type)))
        continue;
      const itemId = string(item.id);
      const key = identity(string(turn.turnId), itemId);
      if (!itemId || visible.has(key)) throw incomplete();
      const assistant = item.type === "agentMessage";
      if (assistant && typeof item.text !== "string") throw incomplete();
      // Only fully understood text inputs can be frozen into the handoff baseline.
      const parts = list(item.content).map(record);
      if (
        !assistant &&
        (!Array.isArray(item.content) ||
          parts.some((part) => part.type !== "text" || typeof part.text !== "string"))
      )
        throw new Error(
          "Connecting a native conversation with input attachments is not supported yet. Its saved history remains available.",
        );
      const text =
        assistant || (item.type === "steeringUserMessage" && typeof item.text === "string")
          ? string(item.text)
          : parts
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => string(part.text))
              .join("\n");
      visible.set(key, { role: assistant ? "assistant" : "user", text });
    }
  }
  const saved = new Map(
    history.messages.map((message) => [identity(message.turnId, message.itemId), message]),
  );
  if (saved.size !== history.messages.length || visible.size !== saved.size) throw incomplete();
  for (const [key, value] of visible) {
    const message = saved.get(key);
    if (!message || message.role !== value.role || message.text !== value.text) throw incomplete();
  }
  const instanceId = Contracts.ProviderInstanceId.make(DESKTOP_INSTANCE_ID);
  const modelSelection = {
    ...desktopModelSelection(records.thread.modelSelection, {
      ...snapshot.state,
      latestModel: snapshot.view.model,
    }),
    instanceId,
  };
  const providerThread: Contracts.OrchestrationV2ProviderThread = {
    ...owner,
    id: Contracts.ProviderThreadId.make(`desktop-provider-thread:${nativeId}`),
    providerInstanceId: instanceId,
    providerSessionId: null,
    nativeMetadata: {
      modelSelection,
      codexDesktopHandoff: { sourceProviderThreadId: owner.id, baselineTurnIds: turnIds },
    },
    status: "idle",
    ownerNodeId: null,
    nativeConversationHeadRef: null,
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt: now,
    updatedAt: now,
  };
  const events: Contracts.OrchestrationV2DomainEvent[] = [
    ...codexHistoryEvents(history, owner, records, now, `${eventPrefix}:history`),
    {
      id: Contracts.EventId.make(`${eventPrefix}:provider`),
      type: "provider-thread.updated",
      threadId: records.thread.id,
      occurredAt: now,
      payload: providerThread,
    },
    {
      id: Contracts.EventId.make(`${eventPrefix}:thread`),
      type: "thread.metadata-updated",
      threadId: records.thread.id,
      occurredAt: now,
      payload: {
        ...records.thread,
        ...(typeof snapshot.state.title === "string"
          ? observeSharedTitle(records.thread, snapshot.state.title, {
              epoch: snapshot.view.epoch,
              revision: snapshot.view.revision,
            })
          : {}),
        codexSharedOwner: "desktop",
        providerInstanceId: instanceId,
        activeProviderThreadId: providerThread.id,
        modelSelection,
        updatedAt: now,
      },
    },
  ];
  return { events, providerThread };
}
