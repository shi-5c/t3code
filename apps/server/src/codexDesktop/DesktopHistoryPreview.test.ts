// @effect-diagnostics nodeBuiltinImport:off - Exercises the native SQLite and bounded file-read boundary together.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { readDesktopHistoryPreview } from "./DesktopHistoryPreview.ts";

it("previews archived workspace-less history without native execution or modification and rejects escaped paths", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-preview-"));
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    const file = NodePath.join(root, "rollout.jsonl");
    const contents =
      Array.from({ length: 205 }, (_, index) =>
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: index % 2 ? "assistant" : "user",
            content: [{ type: "input_text", text: `message-${index}` }],
          },
        }),
      ).join("\n") + "\n{unfinished";
    NodeFS.writeFileSync(file, contents);
    db.exec(
      "CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, archived INTEGER, rollout_path TEXT)",
    );
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run("saved", "Old chat", "", 1, file);
    db.exec("PRAGMA query_only = ON");
    const result = readDesktopHistoryPreview(db, root, "saved");
    expect(result.archived).toBe(true);
    expect(result.cwd).toBe("");
    expect(result.messages).toHaveLength(200);
    expect(result.messages[0]?.text).toBe("message-5");
    expect(result.truncated).toBe(true);
    expect(NodeFS.readFileSync(file, "utf8")).toBe(contents);
    const response = {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "repeat" }] },
    };
    const event = { type: "event_msg", payload: { type: "user_message", message: "repeat" } };
    for (const records of [[event], [event, response], [response, event]]) {
      NodeFS.writeFileSync(file, records.map((row) => JSON.stringify(row)).join("\n"));
      expect(
        readDesktopHistoryPreview(db, root, "saved").messages.map((message) => message.text),
      ).toEqual(["repeat"]);
    }
    NodeFS.writeFileSync(
      file,
      [
        { type: "session_meta", payload: { history_base: { id: "parent", path: "parent.jsonl" } } },
        event,
        { type: "turn_context" },
        event,
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    expect(readDesktopHistoryPreview(db, root, "saved").messages).toHaveLength(2);
    expect(readDesktopHistoryPreview(db, root, "saved").truncated).toBe(true);
    NodeFS.mkdirSync(NodePath.join(root, "nested"));
    expect(() => readDesktopHistoryPreview(db, NodePath.join(root, "nested"), "saved")).toThrow();
    expect(() => readDesktopHistoryPreview(db, root, "absent")).toThrow("unavailable");
  } finally {
    db.close();
    NodeFS.unlinkSync(NodePath.join(root, "rollout.jsonl"));
    if (NodeFS.existsSync(NodePath.join(root, "nested")))
      NodeFS.rmdirSync(NodePath.join(root, "nested"));
    NodeFS.rmdirSync(root);
  }
});
