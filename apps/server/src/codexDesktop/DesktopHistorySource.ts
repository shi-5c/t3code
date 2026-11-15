// @effect-diagnostics nodeBuiltinImport:off - Read-only native metadata boundary; never opens native files for writing.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { string } from "./protocol.ts";
import { classifyDesktopHistory } from "./DesktopHistoryClassification.ts";
import { desktopHistoryMembership } from "./DesktopHistoryMembership.ts";
import type { DesktopHistoryCandidate } from "./DesktopHistoryStore.ts";

export function readDesktopMembershipCache(home: string): unknown {
  try {
    return JSON.parse(NodeFS.readFileSync(NodePath.join(home, ".codex-global-state.json"), "utf8"));
  } catch {
    return {};
  }
}

export function isDesktopHistoryCandidate(metadata: Record<string, unknown>) {
  return classifyDesktopHistory(metadata) !== "internal";
}

/** Includes candidates hidden by provider, project, age, attachment or ordinary list filters. */
export function readDesktopHistoryCandidates(
  home: string,
  cache: unknown,
): ReadonlyArray<DesktopHistoryCandidate> {
  const file = NodeFS.readdirSync(home)
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))[0];
  if (!file)
    throw new Error(
      "The Codex thread index is unavailable; rollout discovery and known-ID reads continue.",
    );
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, file), { readOnly: true });
  try {
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
      "project_id",
    ].filter((name) => columns.has(name));
    return db
      .prepare(
        `SELECT id,title,cwd,archived,updated_at${optional.map((name) => `,${name}`).join("")} FROM threads ORDER BY id`,
      )
      .all()
      .map((row) => ({
        conversationId: String(row.id),
        title: string(row.title) || "Untitled",
        cwd: string(row.cwd),
        attachedToThreadId: string(row.attached_thread_parent_id) || null,
        archived: row.archived === 1,
        updatedAt: Number(row.updated_at),
        membership: desktopHistoryMembership(String(row.id), row.project_id, cache),
        classification: { local: classifyDesktopHistory(row) },
      }));
  } finally {
    db.close();
  }
}
