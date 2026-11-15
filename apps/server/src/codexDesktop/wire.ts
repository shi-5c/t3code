import type { CodexDesktopState, CodexDesktopUpdate } from "@t3tools/contracts";

/** The queue coalesces complete views first; only the delivered views establish delta baselines. */
export function desktopWireUpdate(
  previous: CodexDesktopState | null,
  next: CodexDesktopState,
): CodexDesktopUpdate {
  const reset = !previous || previous.epoch !== next.epoch || next.revision < previous.revision;
  const oldMessages = new Map(
    reset ? [] : previous.messages.map((message) => [message.id, message]),
  );
  const orderChanged =
    reset ||
    previous.messages.length !== next.messages.length ||
    next.messages.some((message, index) => message.id !== previous.messages[index]?.id);
  const { messages, ...metadata } = next;
  return {
    metadata,
    reset,
    upsert: messages.filter((message) => {
      const old = oldMessages.get(message.id);
      return !old || old.text !== message.text || old.role !== message.role;
    }),
    order: orderChanged ? messages.map((message) => message.id) : null,
  };
}
