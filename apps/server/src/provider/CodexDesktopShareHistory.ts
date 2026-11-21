import {
  CODEX_DESKTOP_SHARE_DRIVER,
  EventId,
  MessageId,
  PlanId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type {
  V2ThreadTurnsListResponse,
  V2ThreadTurnsListResponse__Turn,
} from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

type HistoryClient = Pick<CodexClient.CodexAppServerClient["Service"], "request">;

export const readDesktopShareThread = Effect.fn("CodexDesktopShare.readThread")(function* (
  client: HistoryClient,
  threadId: string,
) {
  const { thread } = yield* client.request("thread/read", { threadId, includeTurns: false });
  if (thread.id !== threadId) {
    return yield* CodexErrors.CodexAppServerRequestError.internalError(
      "Unexpected native thread ID.",
    );
  }
  return thread;
});

export const readDesktopShareHistory = Effect.fn("CodexDesktopShare.readHistory")(function* (
  client: HistoryClient,
  threadId: string,
) {
  const thread = yield* readDesktopShareThread(client, threadId);
  if (thread.historyMode === "legacy") {
    const response = yield* client.request("thread/read", { threadId, includeTurns: true });
    if (response.thread.id !== threadId) {
      return yield* CodexErrors.CodexAppServerRequestError.internalError(
        "Unexpected native thread ID.",
      );
    }
    return { thread, turns: response.thread.turns };
  }
  const turns = new Map<string, V2ThreadTurnsListResponse__Turn>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: V2ThreadTurnsListResponse = yield* client.request("thread/turns/list", {
      threadId,
      cursor,
      limit: 50,
      sortDirection: "asc",
      itemsView: "full",
    });
    for (const turn of page.data) turns.set(turn.id, turn);
    cursor = page.nextCursor ?? null;
    if (cursor !== null) {
      if (seenCursors.has(cursor)) {
        return yield* CodexErrors.CodexAppServerRequestError.internalError(
          "Repeated native history cursor.",
        );
      }
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
  return { thread, turns: [...turns.values()] };
});

export function projectDesktopShareHistory(input: {
  readonly threadId: ThreadId;
  readonly providerThread: Pick<OrchestrationV2ProviderThread, "id">;
  readonly nativeCreatedAt: number;
  readonly turns: ReadonlyArray<V2ThreadTurnsListResponse__Turn>;
  readonly ownedTurnIds: ReadonlySet<string>;
  readonly existingItems: ReadonlySet<TurnItemId>;
  readonly existingNativeItems: ReadonlyMap<string, OrchestrationV2TurnItem>;
  readonly existingMessages: ReadonlyMap<string, OrchestrationV2ConversationMessage>;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { providerThread, threadId } = input;
  const events: OrchestrationV2DomainEvent[] = [];
  const seenItems = new Set(input.existingItems);
  let ordinal = 0;
  for (const turn of input.turns) {
    if (input.ownedTurnIds.has(turn.id) || turn.status === "inProgress") continue;
    const startedAt = DateTime.makeUnsafe((turn.startedAt ?? input.nativeCreatedAt) * 1_000);
    const completedAt = DateTime.makeUnsafe(
      (turn.completedAt ?? turn.startedAt ?? input.nativeCreatedAt) * 1_000,
    );
    for (const item of turn.items) {
      ordinal += 1;
      const identity = JSON.stringify([providerThread.id, turn.id, item.id]);
      const id = TurnItemId.make(`desktop-share:${identity}`);
      if (seenItems.has(id)) continue;
      seenItems.add(id);
      const knownNative = input.existingNativeItems.get(item.id);
      if (knownNative) {
        if (knownNative.type === "assistant_message" && item.type === "agentMessage") {
          const previous = input.existingMessages.get(knownNative.messageId);
          if (previous && (previous.streaming || previous.text !== item.text)) {
            events.push(
              {
                id: EventId.make(`desktop-share:repair-message:${identity}`),
                type: "message.updated",
                threadId,
                occurredAt: completedAt,
                payload: { ...previous, text: item.text, streaming: false, updatedAt: completedAt },
              },
              {
                id: EventId.make(`desktop-share:repair-item:${identity}`),
                type: "turn-item.updated",
                threadId,
                occurredAt: completedAt,
                payload: {
                  ...knownNative,
                  text: item.text,
                  streaming: false,
                  status: "completed",
                  completedAt,
                  updatedAt: completedAt,
                },
              },
            );
          }
        }
        continue;
      }
      const common = {
        id,
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: providerThread.id,
        providerTurnId: null,
        nativeItemRef: {
          driver: CODEX_DESKTOP_SHARE_DRIVER,
          nativeId: item.id,
          strength: "strong" as const,
        },
        parentItemId: null,
        ordinal,
        status: "completed" as const,
        title: null,
        startedAt,
        completedAt,
        updatedAt: completedAt,
      };
      let turnItem: OrchestrationV2TurnItem;
      switch (item.type) {
        case "userMessage":
        case "agentMessage": {
          if (
            item.type === "userMessage" &&
            item.clientId &&
            input.existingMessages.has(item.clientId)
          )
            continue;
          const role = item.type === "userMessage" ? "user" : "assistant";
          const text =
            item.type === "userMessage"
              ? item.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
              : item.text;
          const messageId = MessageId.make(`desktop-share:${identity}`);
          const message: OrchestrationV2ConversationMessage = {
            id: messageId,
            threadId,
            runId: null,
            nodeId: null,
            role,
            text,
            attachments: [],
            streaming: false,
            createdBy: role === "user" ? "user" : "agent",
            creationSource: "server",
            createdAt: role === "user" ? startedAt : completedAt,
            updatedAt: completedAt,
          };
          events.push({
            id: EventId.make(`desktop-share:message:${identity}`),
            type: "message.updated",
            threadId,
            occurredAt: completedAt,
            payload: message,
          });
          turnItem =
            role === "user"
              ? {
                  ...common,
                  createdBy: "user",
                  creationSource: "server",
                  type: "user_message",
                  messageId,
                  inputIntent: "turn_start",
                  text,
                  attachments: [],
                }
              : { ...common, type: "assistant_message", messageId, text, streaming: false };
          break;
        }
        case "reasoning":
          turnItem = {
            ...common,
            type: "reasoning",
            text: [...(item.summary ?? []), ...(item.content ?? [])].join("\n"),
            streaming: false,
          };
          break;
        case "commandExecution":
          turnItem = {
            ...common,
            type: "command_execution",
            input: item.command,
            status:
              item.status === "failed"
                ? "failed"
                : item.status === "declined"
                  ? "cancelled"
                  : "completed",
            ...(item.aggregatedOutput == null ? {} : { output: item.aggregatedOutput }),
            ...(item.exitCode == null ? {} : { exitCode: item.exitCode }),
          };
          break;
        case "plan":
          turnItem = {
            ...common,
            type: "proposed_plan",
            planId: PlanId.make(`desktop-share:${identity}`),
            markdown: item.text,
            streaming: false,
          };
          break;
        default:
          turnItem = {
            ...common,
            type: "dynamic_tool",
            toolName: "tool" in item ? item.tool || item.type : item.type,
            input: "arguments" in item ? item.arguments : item,
            ...(item.type === "mcpToolCall" ? { output: item.result ?? item.error } : {}),
            ...(item.type === "dynamicToolCall" ? { output: item.contentItems } : {}),
          };
      }
      events.push({
        id: EventId.make(`desktop-share:item:${identity}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: completedAt,
        payload: turnItem,
      });
    }
  }
  return events;
}
