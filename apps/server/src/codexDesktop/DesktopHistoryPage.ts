import type { CodexDesktopHistoryPage, CodexDesktopHistoryPageInput } from "@t3tools/contracts";
import type { DesktopHistoryStore } from "./DesktopHistoryStore.ts";
import { desktopHistorySourceId } from "./DesktopHistoryStore.ts";

export function desktopHistoryPage(
  store: DesktopHistoryStore,
  source: string,
  input: CodexDesktopHistoryPageInput,
): CodexDesktopHistoryPage {
  if (desktopHistorySourceId(source) !== input.sourceId)
    throw new Error(
      "The Desktop history source changed. The selected snapshot is unavailable in this source.",
    );
  const version = store.readVersion(source, input.conversationId, input.cursor?.snapshot);
  if (!version?.history.canonical) {
    if (input.cursor)
      throw new Error(
        "This history snapshot is unavailable. Keep the loaded pages and reopen history to start a new snapshot.",
      );
    return {
      conversationId: input.conversationId,
      thread: null,
      entries: [],
      nextCursor: null,
      totalItems: 0,
    };
  }
  const canonical = version.history.canonical;
  const itemMetadata = new Map(
    canonical.itemEntries.map((entry) => [
      `${entry.turnId}:${(entry.item as { id?: string } | undefined)?.id}`,
      Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "item")),
    ]),
  );
  const all = canonical.turns.flatMap((turn): Array<CodexDesktopHistoryPage["entries"][number]> => {
    const metadata = { ...turn, items: [] };
    return turn.items.length
      ? turn.items.map((item) => ({
          turn: metadata,
          item,
          metadata: itemMetadata.get(`${turn.id}:${item.id}`),
        }))
      : [{ turn: metadata, item: null }];
  });
  const offset = input.cursor?.offset ?? 0;
  if (input.cursor && offset >= all.length)
    throw new Error("This history cursor is outside its snapshot. Reopen history to start again.");
  const entries = all.slice(offset, offset + 25);
  return {
    conversationId: input.conversationId,
    thread: { ...canonical.thread, turns: [] },
    entries,
    nextCursor: offset + 25 < all.length ? { snapshot: version.hash, offset: offset + 25 } : null,
    totalItems: all.length,
  };
}
