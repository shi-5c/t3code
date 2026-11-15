import type { CodexDesktopState, CodexDesktopUpdate } from "@t3tools/contracts";

export function mergeDesktopUpdate(
  previous: CodexDesktopState | null,
  update: CodexDesktopUpdate,
): CodexDesktopState {
  if (!update.reset && (!previous || previous.epoch !== update.metadata.epoch))
    throw new Error("Codex Desktop update has no matching snapshot.");
  if (update.reset && !update.order)
    throw new Error("Codex Desktop snapshot has no message order.");
  const messagesById = new Map(
    update.reset ? [] : previous?.messages.map((message) => [message.id, message]),
  );
  for (const message of update.upsert) messagesById.set(message.id, message);
  const order = update.order ?? previous?.messages.map((message) => message.id) ?? [];
  const messages =
    !update.reset && !update.order && !update.upsert.length && previous
      ? previous.messages
      : order.map((id) => {
          const message = messagesById.get(id);
          if (!message) throw new Error("Codex Desktop update is missing a message.");
          return message;
        });
  return { ...update.metadata, messages };
}
