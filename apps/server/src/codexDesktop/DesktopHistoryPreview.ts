// @effect-diagnostics nodeBuiltinImport:off - A bounded synchronous read shares the native SQLite boundary and closes both handles before returning.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";
import type { CodexDesktopPreview } from "@t3tools/contracts";

const MAX_BYTES = 2 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Preview text only: file offsets are not native item IDs and must never enter the shared merge. */
export function readDesktopHistoryPreview(
  db: NodeSqlite.DatabaseSync,
  home: string,
  id: string,
): CodexDesktopPreview {
  const row = db
    .prepare("SELECT id, title, cwd, archived, rollout_path FROM threads WHERE id = ?")
    .get(id);
  if (!row || typeof row.rollout_path !== "string")
    throw new Error("Saved conversation history is unavailable.");
  const root = NodeFS.realpathSync(home);
  const file = NodeFS.realpathSync(row.rollout_path);
  const relative = NodePath.relative(root, file);
  if (
    relative.startsWith(`..${NodePath.sep}`) ||
    relative === ".." ||
    NodePath.isAbsolute(relative) ||
    !file.endsWith(".jsonl")
  )
    throw new Error("The saved history path is outside this Codex home.");
  const handle = NodeFS.openSync(file, "r");
  try {
    const size = NodeFS.fstatSync(handle).size;
    const start = Math.max(0, size - MAX_BYTES);
    const bytes = Buffer.alloc(Math.min(size, MAX_BYTES));
    const count = NodeFS.readSync(handle, bytes, 0, bytes.length, start);
    let content = bytes.subarray(0, count).toString("utf8");
    if (start > 0) content = content.slice(content.indexOf("\n") + 1);
    let truncated = start > 0 || NodeFS.fstatSync(handle).size !== size;
    const messages: Array<{
      previewKey: string;
      role: "user" | "assistant";
      text: string;
      source: "event" | "response";
    }> = [];
    let lineNumber = 0;
    let turnStart = 0;
    for (const line of content.split("\n")) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = object(JSON.parse(line));
      } catch {
        truncated = true;
        continue;
      }
      const item = object(record.payload);
      if (
        record.type === "history_base" ||
        record.type === "compacted" ||
        (record.type === "session_meta" &&
          (item.forked_from_id || item.forked_from || item.history_base))
      )
        truncated = true;
      if (
        record.type === "turn_context" ||
        (record.type === "event_msg" && item.type === "task_started")
      )
        turnStart = messages.length;
      const eventRole =
        record.type === "event_msg" && typeof item.message === "string"
          ? item.type === "user_message"
            ? "user"
            : item.type === "agent_message"
              ? "assistant"
              : null
          : null;
      const responseRole =
        record.type === "response_item" &&
        item.type === "message" &&
        (item.role === "user" || item.role === "assistant") &&
        Array.isArray(item.content)
          ? item.role
          : null;
      const role = eventRole ?? responseRole;
      if (!role) continue;
      const source = eventRole ? "event" : "response";
      const text = eventRole
        ? String(item.message)
        : (item.content as unknown[])
            .map((part: unknown) => {
              const value = object(part);
              return (value.type === "input_text" ||
                value.type === "output_text" ||
                value.type === "text") &&
                typeof value.text === "string"
                ? value.text
                : "";
            })
            .filter(Boolean)
            .join("\n");
      if (!text) continue;
      const duplicate = messages.findLastIndex(
        (message, index) =>
          index >= turnStart &&
          message.role === role &&
          message.text === text &&
          message.source !== source,
      );
      if (duplicate >= 0) {
        if (source === "response") continue;
        messages.splice(duplicate, 1);
      }
      if (text.length > 32_000) truncated = true;
      messages.push({
        previewKey: `${start}:${lineNumber}`,
        role,
        text: text.slice(0, 32_000),
        source,
      });
      if (messages.length > 200) {
        messages.shift();
        turnStart = Math.max(0, turnStart - 1);
        truncated = true;
      }
    }
    return {
      conversationId: id,
      title: String(row.title || "Untitled"),
      cwd: String(row.cwd || ""),
      archived: row.archived === 1,
      messages: messages.map(({ previewKey, role, text }) => ({ previewKey, role, text })),
      truncated,
    };
  } finally {
    NodeFS.closeSync(handle);
  }
}
