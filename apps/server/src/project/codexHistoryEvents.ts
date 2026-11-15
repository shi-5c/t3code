import {
  EventId,
  MessageId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { ProjectionRecords } from "../orchestration-v2/ProjectionStore.ts";
import type { CodexHistory } from "./CodexSessionHistory.ts";

const PREFIX = "codex-history:";

export function codexHistoryEvents(
  history: CodexHistory,
  providerThread: OrchestrationV2ProviderThread,
  records: ProjectionRecords<"messages" | "turnItems" | "providerTurns" | "runs">,
  now: DateTime.Utc,
  eventPrefix: string,
  timestampSource: "observation" | "native" = "observation",
): ReadonlyArray<OrchestrationV2DomainEvent> {
  if (history.nativeThreadId !== providerThread.nativeThreadRef?.nativeId)
    throw new Error("Native history does not belong to this provider thread.");
  if (providerThread.appThreadId !== records.thread.id)
    throw new Error("Native provider thread belongs to another conversation.");
  if (
    records.runs.some((run) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    )
  )
    throw new Error("Native history reconciliation waits for local work to finish.");
  // Ordinal-only legacy imports cannot be matched safely to native IDs after truncation.
  if (
    records.thread.historyOrigin === "v1_import" &&
    records.messages.some((message) => message.runId === null && !message.id.startsWith(PREFIX))
  )
    throw new Error(
      "This legacy import needs an explicit history migration before synchronization.",
    );
  const localTurns = new Set(
    records.providerTurns.flatMap((turn) =>
      turn.providerThreadId === providerThread.id && turn.nativeTurnRef?.nativeId
        ? [turn.nativeTurnRef.nativeId]
        : [],
    ),
  );
  const localRunByNativeTurn = new Map(
    records.providerTurns.flatMap((turn) => {
      const run = records.runs.find((run) => run.rootNodeId === turn.nodeId);
      return turn.providerThreadId === providerThread.id && turn.nativeTurnRef?.nativeId && run
        ? [[turn.nativeTurnRef.nativeId, run.id] as const]
        : [];
    }),
  );
  let afterRunId: RunId | null = null;
  const anchorByTurn = new Map<string, RunId | null>();
  for (const turnId of history.turnIds ?? [
    ...new Set(history.messages.map((message) => message.turnId)),
  ]) {
    afterRunId = localRunByNativeTurn.get(turnId) ?? afterRunId;
    anchorByTurn.set(turnId, afterRunId);
  }
  const indexes = new Map<RunId | null, number>();
  const messages = new Map(records.messages.map((message) => [message.id, message]));
  const items = new Map(records.turnItems.map((item) => [item.id, item]));
  const identityFor = (turnId: string, itemId: string) =>
    [records.thread.id, providerThread.id, turnId, itemId].map(encodeURIComponent).join(":");
  const observedItemIds = new Set(
    history.messages
      .filter((message) => !localTurns.has(message.turnId))
      .map((message) => `${PREFIX}item:${identityFor(message.turnId, message.itemId)}`),
  );
  const known = records.turnItems.filter(
    (item) =>
      item.providerThreadId === providerThread.id && item.nativeHistoryPosition !== undefined,
  );
  const partial =
    known.some((item) => !observedItemIds.has(item.id)) ||
    // A text-complete snapshot can still omit tool-only local turns that anchor positions.
    [...localRunByNativeTurn.keys()].some((turnId) => !anchorByTurn.has(turnId));
  const lastKnownIndex = new Map<RunId | null, number>();
  for (const item of known) {
    const position = item.nativeHistoryPosition!;
    lastKnownIndex.set(
      position.afterRunId,
      Math.max(lastKnownIndex.get(position.afterRunId) ?? 0, position.index),
    );
  }
  const events: OrchestrationV2DomainEvent[] = [];
  let eventOrdinal = 0;
  const eventId = () => EventId.make(`${eventPrefix}:${++eventOrdinal}`);
  let ordinal = Math.max(0, ...records.turnItems.map((item) => item.ordinal));
  for (const native of history.messages) {
    // The live adapter owns all artifacts of a T3 run, including its original input ID.
    if (localTurns.has(native.turnId)) continue;
    const identity = identityFor(native.turnId, native.itemId);
    const messageId = MessageId.make(`${PREFIX}message:${identity}`);
    const itemId = TurnItemId.make(`${PREFIX}item:${identity}`);
    const previous = messages.get(messageId);
    if (previous && previous.role !== native.role)
      throw new Error("Native history changed the role of an existing message.");
    const anchor = anchorByTurn.has(native.turnId)
      ? anchorByTurn.get(native.turnId)!
      : (items.get(itemId)?.nativeHistoryPosition?.afterRunId ?? null);
    const index = (indexes.get(anchor) ?? 0) + 1;
    indexes.set(anchor, index);
    const previousPosition = items.get(itemId)?.nativeHistoryPosition;
    const position = partial
      ? (previousPosition ?? { afterRunId: anchor, index: (lastKnownIndex.get(anchor) ?? 0) + 1 })
      : { afterRunId: anchor, index };
    lastKnownIndex.set(
      position.afterRunId,
      Math.max(lastKnownIndex.get(position.afterRunId) ?? 0, position.index),
    );
    const positionChanged =
      previousPosition?.afterRunId !== position.afterRunId ||
      previousPosition.index !== position.index;
    // An independent reader can lag a persisted snapshot; never shrink known message text.
    // Text retention is independent of canonical position changes in a complete snapshot.
    const text = previous?.text.startsWith(native.text) ? previous.text : native.text;
    if (previous?.text === text && !positionChanged) continue;
    if (previous && !text.startsWith(previous.text))
      throw new Error(
        "Native history was rewritten; automatic text backfill requires an authoritative rebuild.",
      );
    const at = previous?.createdAt ?? DateTime.makeUnsafe(native.createdAt);
    const message = {
      createdBy: native.role === "user" ? ("user" as const) : ("agent" as const),
      creationSource: "provider" as const,
      id: messageId,
      threadId: records.thread.id,
      runId: null,
      nodeId: null,
      role: native.role,
      text,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: timestampSource === "native" ? (previous?.updatedAt ?? at) : now,
    };
    const common = {
      id: itemId,
      threadId: records.thread.id,
      runId: null,
      nodeId: null,
      providerThreadId: providerThread.id,
      nativeHistoryPosition: position,
      providerTurnId: null,
      nativeItemRef: {
        driver: providerThread.driver,
        nativeId: native.itemId,
        strength: "strong" as const,
      },
      parentItemId: null,
      ordinal: items.get(itemId)?.ordinal ?? ++ordinal,
      // A persisted observation is not an authoritative execution-state notification.
      status: "idle" as const,
      title: null,
      startedAt: at,
      completedAt: null,
      updatedAt: timestampSource === "native" ? (items.get(itemId)?.updatedAt ?? at) : now,
      messageId,
      text,
    };
    events.push(
      {
        id: eventId(),
        type: "message.updated",
        threadId: records.thread.id,
        occurredAt: now,
        payload: message,
      },
      {
        id: eventId(),
        type: "turn-item.updated",
        threadId: records.thread.id,
        occurredAt: now,
        payload:
          native.role === "user"
            ? {
                ...common,
                type: "user_message",
                createdBy: "user",
                creationSource: "provider",
                inputIntent: "turn_start",
                attachments: [],
              }
            : { ...common, type: "assistant_message", streaming: false },
      },
    );
  }
  if (history.omittedItemTypes.length) {
    const id = TurnItemId.make(`${PREFIX}omitted:${records.thread.id}`);
    const message = `Imported Codex text history. These native items are not displayed yet: ${history.omittedItemTypes.join(", ")}. Open Codex to view them.`;
    const previous = items.get(id);
    if (previous?.type !== "system_notice" || previous.message !== message)
      events.push({
        id: eventId(),
        type: "turn-item.updated",
        threadId: records.thread.id,
        occurredAt: now,
        payload: {
          id,
          threadId: records.thread.id,
          runId: null,
          nodeId: null,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: previous?.ordinal ?? ++ordinal,
          status: "completed",
          title: null,
          startedAt: previous?.startedAt ?? now,
          completedAt: now,
          updatedAt: now,
          type: "system_notice",
          message,
        },
      });
  }
  return events;
}
