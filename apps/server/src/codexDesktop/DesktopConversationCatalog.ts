import { isDesktopHistoryCandidate } from "./DesktopHistorySource.ts";
import type * as NodeSqlite from "node:sqlite";
import type { CodexDesktopList, CodexDesktopListInput } from "@t3tools/contracts";

const PAGE_SIZE = 100;

/** Uses the caller's read-only database; discovery never invokes Codex's repair-capable list. */
export function readDesktopConversationPage(
  db: NodeSqlite.DatabaseSync,
  input: CodexDesktopListInput = {},
): CodexDesktopList {
  const query = (input.query ?? "").trim();
  const archived = input.archived ?? "active";
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(threads)")
      .all()
      .map((row) => String(row.name)),
  );
  const optional = [
    "source",
    "thread_source",
    "parent_thread_id",
    "attached_thread_parent_id",
    "ephemeral",
  ].filter((name) => columns.has(name));
  const queryPage = db.prepare(`
    SELECT id, title, cwd, archived, updated_at${optional.map((name) => `,${name}`).join("")} FROM threads
    WHERE (? = 'all' OR archived = CASE WHEN ? = 'archived' THEN 1 ELSE 0 END)
      AND (? = '' OR instr(lower(coalesce(title, '') || ' ' || coalesce(cwd, '') || ' ' || id), lower(?)) > 0)
      AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
    ORDER BY updated_at DESC, id DESC LIMIT ?
  `);
  const rows: Array<Record<string, unknown>> = [];
  let cursor = input.cursor ?? null;
  while (rows.length <= PAGE_SIZE) {
    const batch = queryPage.all(
      archived,
      archived,
      query,
      query,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.id ?? "",
      PAGE_SIZE + 1,
    );
    if (!batch.length) break;
    for (const row of batch) {
      cursor = { updatedAt: Number(row.updated_at), id: String(row.id) };
      if (isDesktopHistoryCandidate(row) && !row.attached_thread_parent_id) rows.push(row);
      if (rows.length > PAGE_SIZE) break;
    }
    if (batch.length <= PAGE_SIZE) break;
  }
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    supported: true,
    detail:
      "All ages are included. Open a conversation in Codex Desktop to connect its live owner. Refresh to include conversations changed while paging.",
    conversations: page.map((row) => ({
      conversationId: String(row.id),
      title: String(row.title || "Untitled"),
      cwd: String(row.cwd || ""),
      archived: row.archived === 1,
      updatedAt: Number(row.updated_at),
    })),
    nextCursor:
      rows.length > PAGE_SIZE && last
        ? { updatedAt: Number(last.updated_at), id: String(last.id) }
        : null,
  };
}
