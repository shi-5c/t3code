import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { readDesktopConversationPage } from "./DesktopConversationCatalog.ts";

it("pages every age and project assignment, filters archives and searches beyond the first page without writing", () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, archived INTEGER, updated_at INTEGER, project_id TEXT)",
    );
    const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)");
    for (let i = 0; i < 205; i++)
      insert.run(
        `id-${String(i).padStart(3, "0")}`,
        `Chat ${i}`,
        i === 0 ? "" : "/workspace",
        0,
        1000,
        null,
      );
    insert.run("archived", "Old archived", "/old", 1, 1, "former-project");
    db.exec("PRAGMA query_only = ON");
    const first = readDesktopConversationPage(db);
    const second = readDesktopConversationPage(db, { cursor: first.nextCursor! });
    const third = readDesktopConversationPage(db, { cursor: second.nextCursor! });
    expect(first.conversations).toHaveLength(100);
    expect(second.conversations).toHaveLength(100);
    expect(third.conversations).toHaveLength(5);
    expect(third.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.conversations, ...second.conversations, ...third.conversations].map(
          (row) => row.conversationId,
        ),
      ).size,
    ).toBe(205);
    expect(third.conversations.at(-1)?.cwd).toBe("");
    expect(
      readDesktopConversationPage(db, { query: "Chat 0" }).conversations.map(
        (row) => row.conversationId,
      ),
    ).toEqual(["id-000"]);
    expect(readDesktopConversationPage(db, { query: "%" }).conversations).toEqual([]);
    expect(
      readDesktopConversationPage(db, { archived: "archived" }).conversations.map(
        (row) => row.conversationId,
      ),
    ).toEqual(["archived"]);
    expect(
      readDesktopConversationPage(db, { archived: "all", query: "archived" }).conversations[0]
        ?.updatedAt,
    ).toBe(1);
    db.exec("PRAGMA query_only = OFF");
    db.prepare("UPDATE threads SET updated_at = 2000 WHERE id = ?").run("id-001");
    db.exec("PRAGMA query_only = ON");
    expect(
      readDesktopConversationPage(db, { cursor: second.nextCursor! }).conversations.some(
        (row) => row.conversationId === "id-001",
      ),
    ).toBe(false);
    const refreshed = readDesktopConversationPage(db);
    expect(refreshed.conversations[0]?.conversationId).toBe("id-001");
    expect(refreshed.detail).toContain("Refresh");
  } finally {
    db.close();
  }
});

it("skips internal and attached rows across native pages while retaining unclassified chat candidates", () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE threads (id TEXT,title TEXT,cwd TEXT,archived INTEGER,updated_at INTEGER,source TEXT,attached_thread_parent_id TEXT)",
    );
    const insert = db.prepare("INSERT INTO threads VALUES (?,?,?,0,?,?,?)");
    for (let i = 0; i < 120; i++)
      insert.run(
        `internal-${i}`,
        "Guardian",
        "/workspace",
        1000,
        JSON.stringify({ subagent: { other: "guardian" } }),
        null,
      );
    insert.run("attached", "Attached", "/workspace", 900, "vscode", "parent");
    insert.run("unknown", "Unknown source", "/workspace", 1, "custom", null);
    db.exec("PRAGMA query_only=ON");
    expect(readDesktopConversationPage(db).conversations.map((row) => row.conversationId)).toEqual([
      "unknown",
    ]);
  } finally {
    db.close();
  }
});
