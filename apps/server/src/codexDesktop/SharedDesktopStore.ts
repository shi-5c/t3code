// @effect-diagnostics nodeBuiltinImport:off - Dedicated SQLite boundary; the Effect service owns its lifetime.
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import type { SharedDesktopTurnContext } from "./sharedProjection.ts";
import { desktopTurns } from "./projection.ts";
import { record, string } from "./protocol.ts";

export interface SharedDesktopBinding {
  readonly threadId: string;
  readonly conversationId: string;
  readonly projectId: string;
  readonly instanceId: string;
}

export type DesktopDeliveryReservation =
  | { readonly type: "new" }
  | { readonly type: "acknowledged"; readonly result: unknown }
  | { readonly type: "unknown" };

/** Separate from the upstream migration sequence so merging upstream cannot renumber fork tables. */
export class SharedDesktopStore {
  private readonly database: NodeSqlite.DatabaseSync;
  private readonly changeListeners = new Map<string, Set<() => void>>();
  private readonly responsesInFlight = new Map<string, number>();
  subscribe(conversationId: string, listener: () => void) {
    const listeners = this.changeListeners.get(conversationId) ?? new Set<() => void>();
    listeners.add(listener);
    this.changeListeners.set(conversationId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.changeListeners.delete(conversationId);
    };
  }
  private changed(conversationId: string) {
    for (const listener of this.changeListeners.get(conversationId) ?? []) listener();
  }
  private threadChanged(threadId: string) {
    const binding = this.bindings().find((row) => row.threadId === threadId);
    if (binding) this.changed(binding.conversationId);
  }
  beginResponse(conversationId: string, requestId: string) {
    this.responsesInFlight.set(requestId, (this.responsesInFlight.get(requestId) ?? 0) + 1);
    this.changed(conversationId);
    return () => {
      const count = this.responsesInFlight.get(requestId) ?? 0;
      if (count <= 1) this.responsesInFlight.delete(requestId);
      else this.responsesInFlight.set(requestId, count - 1);
      this.changed(conversationId);
    };
  }
  isResponseInFlight(requestId: string) {
    return this.responsesInFlight.has(requestId);
  }
  private readonly liveAttempts = new Map<string, number>();
  activateAttempt(attemptId: string) {
    this.liveAttempts.set(attemptId, (this.liveAttempts.get(attemptId) ?? 0) + 1);
    return () => {
      const count = this.liveAttempts.get(attemptId) ?? 0;
      if (count <= 1) this.liveAttempts.delete(attemptId);
      else this.liveAttempts.set(attemptId, count - 1);
    };
  }
  isAttemptLive(attemptId: string) {
    return this.liveAttempts.has(attemptId);
  }
  constructor(path: string) {
    this.database = new NodeSqlite.DatabaseSync(path);
    this.database.exec(`
      PRAGMA busy_timeout = 2500;
      CREATE TABLE IF NOT EXISTS bindings (
        thread_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        instance_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        command_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('reserved', 'acknowledged')),
        result_json TEXT
      );
      CREATE TABLE IF NOT EXISTS turn_contexts (
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        native_turn_id TEXT,
        context_json TEXT NOT NULL,
        PRIMARY KEY (conversation_id, message_id),
        UNIQUE (conversation_id, native_turn_id)
      );
      CREATE TABLE IF NOT EXISTS submissions (
        attempt_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        candidate_id TEXT
      );
    `);
    // A previous process cannot still be waiting for its acknowledgement.
    this.database.exec("UPDATE submissions SET phase='unknown' WHERE phase='pending'");
  }
  close() {
    this.database.close();
  }
  bind(binding: SharedDesktopBinding) {
    this.database
      .prepare(
        "INSERT OR IGNORE INTO bindings (thread_id,conversation_id,project_id,instance_id) VALUES (?,?,?,?)",
      )
      .run(binding.threadId, binding.conversationId, binding.projectId, binding.instanceId);
    const actual = this.bindings().find(
      (row) => row.threadId === binding.threadId || row.conversationId === binding.conversationId,
    );
    if (
      !actual ||
      actual.threadId !== binding.threadId ||
      actual.conversationId !== binding.conversationId ||
      actual.projectId !== binding.projectId ||
      actual.instanceId !== binding.instanceId
    )
      throw new Error("This Codex conversation already has a different T3 binding.");
  }
  bindings(): SharedDesktopBinding[] {
    return this.database
      .prepare(
        "SELECT thread_id,conversation_id,project_id,instance_id FROM bindings ORDER BY thread_id",
      )
      .all()
      .map((row) => ({
        threadId: String(row.thread_id),
        conversationId: String(row.conversation_id),
        projectId: String(row.project_id),
        instanceId: String(row.instance_id),
      }));
  }
  rememberTurn(conversationId: string, context: SharedDesktopTurnContext, nativeTurnId?: string) {
    this.database
      .prepare(`INSERT INTO turn_contexts (conversation_id,message_id,native_turn_id,context_json) VALUES (?,?,?,?)
      ON CONFLICT (conversation_id,message_id) DO UPDATE SET native_turn_id=COALESCE(excluded.native_turn_id,turn_contexts.native_turn_id),context_json=excluded.context_json`)
      .run(
        conversationId,
        context.clientMessageId || context.runId,
        nativeTurnId ?? null,
        JSON.stringify(context),
      );
    this.changed(conversationId);
  }
  /** A stream without client IDs must wait for the local start acknowledgement.
   * Check and insert synchronously so the importer and adapter share one identity decision.
   */
  rememberImportedTurn(
    conversationId: string,
    context: SharedDesktopTurnContext,
    nativeTurnId: string,
  ) {
    const rows = this.turnContexts(conversationId);
    if (rows.some((row) => row.nativeTurnId === nativeTurnId)) return false;
    // Without a matching client ID/ack, any new turn may be the delayed send.
    // Pause identity allocation until trusted correlation or explicit user review;
    // the sidebar exposes the durable warning and a confirmed-unsent recovery action.
    if (rows.some((row) => row.nativeTurnId === null && row.context.origin === "t3")) return false;
    this.rememberTurn(conversationId, context, nativeTurnId);
    return true;
  }
  beginSubmission(conversationId: string, attemptId: string) {
    this.database
      .prepare(
        "INSERT INTO submissions(attempt_id,conversation_id,phase) VALUES(?,?,'pending') ON CONFLICT(attempt_id) DO UPDATE SET phase='pending'",
      )
      .run(attemptId, conversationId);
  }
  finishSubmission(attemptId: string, outcomeUnknown: boolean) {
    const row = this.database
      .prepare("SELECT thread_id FROM deliveries WHERE command_id=?")
      .get(attemptId);
    if (outcomeUnknown)
      this.database
        .prepare("UPDATE submissions SET phase='unknown' WHERE attempt_id=?")
        .run(attemptId);
    else {
      this.database
        .prepare(
          "DELETE FROM turn_contexts WHERE native_turn_id IS NULL AND json_extract(context_json,'$.attemptId')=?",
        )
        .run(attemptId);
      this.database.prepare("DELETE FROM submissions WHERE attempt_id=?").run(attemptId);
      this.database
        .prepare("DELETE FROM deliveries WHERE command_id=? AND state='reserved'")
        .run(attemptId);
    }
    if (row) this.threadChanged(String(row.thread_id));
  }
  uncertainSubmissions(conversationId: string) {
    return this.database
      .prepare(
        "SELECT attempt_id,candidate_id FROM submissions WHERE conversation_id=? AND phase='unknown' AND attempt_id IN (SELECT json_extract(context_json,'$.attemptId') FROM turn_contexts WHERE native_turn_id IS NULL)",
      )
      .all(conversationId)
      .map((row) => ({
        attemptId: String(row.attempt_id),
        candidateId: row.candidate_id === null ? null : String(row.candidate_id),
      }));
  }
  dismissUncertain(conversationId: string, attemptId: string) {
    if (!this.uncertainSubmissions(conversationId).some((value) => value.attemptId === attemptId))
      throw new Error("This submission is already resolved.");
    this.database
      .prepare(
        "DELETE FROM turn_contexts WHERE conversation_id=? AND native_turn_id IS NULL AND json_extract(context_json,'$.attemptId')=?",
      )
      .run(conversationId, attemptId);
    this.database.prepare("DELETE FROM submissions WHERE attempt_id=?").run(attemptId);
    // Keep the delivery tombstone: dismissing a warning must never replay a send.
    this.changed(conversationId);
  }
  turnContexts(
    conversationId: string,
  ): ReadonlyArray<{ nativeTurnId: string | null; context: SharedDesktopTurnContext }> {
    return this.database
      .prepare(
        "SELECT native_turn_id,context_json FROM turn_contexts WHERE conversation_id=? ORDER BY rowid",
      )
      .all(conversationId)
      .map((row) => ({
        nativeTurnId: row.native_turn_id === null ? null : String(row.native_turn_id),
        context: JSON.parse(String(row.context_json)),
      }));
  }
  resolveTurnContexts(conversationId: string, state: Record<string, unknown> | null) {
    const turns = state ? desktopTurns(state) : [];
    const result = new Map<string, SharedDesktopTurnContext>();
    for (const row of this.turnContexts(conversationId)) {
      const nativeTurnId =
        row.nativeTurnId ??
        string(
          turns.find(
            (turn) =>
              record(turn.params).clientUserMessageId === row.context.clientMessageId ||
              (Array.isArray(turn.items) &&
                turn.items.some(
                  (raw) =>
                    record(raw).type === "userMessage" &&
                    record(raw).clientId === row.context.clientMessageId,
                )),
          )?.turnId,
        );
      if (!nativeTurnId) continue;
      const context = row.context.providerTurnId.startsWith("desktop-provider-turn:pending:")
        ? { ...row.context, providerTurnId: `desktop-provider-turn:${nativeTurnId}` }
        : row.context;
      if (row.nativeTurnId === null || context !== row.context)
        this.rememberTurn(conversationId, context, nativeTurnId);
      result.set(nativeTurnId, context);
    }
    return result;
  }
  reserve(commandId: string, threadId: string, payload: unknown): DesktopDeliveryReservation {
    // This hash detects command-id misuse without making another copy of chat contents.
    const hash = NodeCrypto.hash("sha256", JSON.stringify(payload));
    const inserted = this.database
      .prepare(
        "INSERT OR IGNORE INTO deliveries (command_id,thread_id,payload_hash,state) VALUES (?,?,?,'reserved')",
      )
      .run(commandId, threadId, hash);
    if (inserted.changes === 1) {
      this.threadChanged(threadId);
      return { type: "new" };
    }
    const row = this.database
      .prepare("SELECT thread_id,payload_hash,state,result_json FROM deliveries WHERE command_id=?")
      .get(commandId);
    if (!row || row.thread_id !== threadId || row.payload_hash !== hash)
      throw new Error("Command identifier was already used for different input.");
    return row.state === "acknowledged"
      ? { type: "acknowledged", result: JSON.parse(String(row.result_json)) }
      : { type: "unknown" };
  }
  acknowledge(commandId: string, result: unknown) {
    const updated = this.database
      .prepare(
        "UPDATE deliveries SET state='acknowledged',result_json=? WHERE command_id=? AND state='reserved'",
      )
      .run(JSON.stringify(result), commandId);
    if (updated.changes !== 1)
      throw new Error("Delivery was not reserved or was already acknowledged.");
    const row = this.database
      .prepare("SELECT thread_id FROM deliveries WHERE command_id=?")
      .get(commandId);
    if (row) this.threadChanged(String(row.thread_id));
  }
  deliveryState(commandId: string) {
    const row = this.database
      .prepare("SELECT state FROM deliveries WHERE command_id=?")
      .get(commandId);
    return row?.state === "acknowledged" ? "acknowledged" : row ? "unknown" : "absent";
  }
  reservedResponseKeys(threadId: string) {
    return new Set(
      this.database
        .prepare(
          "SELECT command_id FROM deliveries WHERE thread_id=? AND command_id LIKE 'desktop-response:%'",
        )
        .all(threadId)
        .map((row) => String(row.command_id)),
    );
  }
  discardUnsentDelivery(commandId: string) {
    const row = this.database
      .prepare("SELECT thread_id FROM deliveries WHERE command_id=?")
      .get(commandId);
    this.database
      .prepare("DELETE FROM deliveries WHERE command_id=? AND state='reserved'")
      .run(commandId);
    if (row) this.threadChanged(String(row.thread_id));
  }
}
