import * as Contracts from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Schema from "effect/Schema";
const decodeProviderEvent = Schema.decodeUnknownSync(ProviderAdapter.ProviderAdapterV2Event);
export const sharedProviderEvents = (
  events: ReadonlyArray<Contracts.OrchestrationV2DomainEvent>,
) => {
  const result: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const terminalEvents: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const runOrdinals = new Map(
    events.flatMap((event) =>
      event.type === "run.updated"
        ? [[event.payload.activeAttemptId, event.payload.ordinal] as const]
        : [],
    ),
  );
  for (const event of events) {
    const common = { driver: "codex" };
    switch (event.type) {
      case "provider-turn.updated":
        result.push(
          decodeProviderEvent({
            ...common,
            type: "provider_turn.updated",
            threadId: event.threadId,
            providerTurn: event.payload,
          }),
        );
        if (!["pending", "running"].includes(event.payload.status)) {
          const status = event.payload.status;
          terminalEvents.push(
            decodeProviderEvent({
              type: "turn.terminal",
              driver: "codex",
              providerThreadId: event.payload.providerThreadId,
              providerTurnId: event.payload.id,
              runOrdinal: runOrdinals.get(event.payload.runAttemptId) ?? event.payload.ordinal,
              status,
              failure:
                status === "failed"
                  ? makeProviderFailure({
                      message: "The Desktop turn failed. Check its native error details.",
                    })
                  : null,
              ...(status === "failed" ? { failureItemOrdinal: 1 } : {}),
              threadDisposition: "reusable",
            }),
          );
        }
        break;
      case "node.updated":
        result.push(decodeProviderEvent({ ...common, type: "node.updated", node: event.payload }));
        break;
      case "plan.updated":
        result.push(decodeProviderEvent({ ...common, type: "plan.updated", plan: event.payload }));
        break;
      case "runtime-request.updated":
        if (event.payload.status === "pending")
          result.push(
            decodeProviderEvent({
              ...common,
              type: "runtime_request.updated",
              threadId: event.threadId,
              runtimeRequest: event.payload,
            }),
          );
        break;
      case "message.updated":
        result.push(
          decodeProviderEvent({ ...common, type: "message.updated", message: event.payload }),
        );
        break;
      case "turn-item.updated":
        result.push(
          decodeProviderEvent({ ...common, type: "turn_item.updated", turnItem: event.payload }),
        );
        break;
      default:
        break;
    }
  }
  const terminal = (event: ProviderAdapter.ProviderAdapterV2Event) =>
    (event.type === "provider_turn.updated" &&
      !["pending", "running"].includes(event.providerTurn.status)) ||
    (event.type === "node.updated" &&
      event.node.countsForRun &&
      ["completed", "failed", "interrupted", "cancelled"].includes(event.node.status));
  return [
    ...result.filter((event) => !terminal(event)),
    ...result.filter(terminal),
    ...terminalEvents,
  ];
};
