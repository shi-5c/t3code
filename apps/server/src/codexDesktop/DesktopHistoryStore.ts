// @effect-diagnostics nodeBuiltinImport:off - Private SQLite cache; its service owns the handle and source scope.
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import type {
  CodexDesktopHistoryEntry,
  CodexDesktopMembership,
  CodexNativeTitleRead,
} from "@t3tools/contracts";
import type { CodexHistory } from "../project/CodexSessionHistory.ts";
import {
  classifyDesktopHistory,
  desktopHistoryClassification,
  mergeDesktopHistoryClassification,
  type DesktopHistoryClassificationEvidence,
} from "./DesktopHistoryClassification.ts";

export interface DesktopHistoryCandidate {
  readonly conversationId: string;
  readonly attachedToThreadId?: string | null;
  readonly title: string;
  readonly cwd: string;
  readonly archived: boolean;
  readonly updatedAt: number;
  readonly membership: CodexDesktopMembership;
  readonly classification?: DesktopHistoryClassificationEvidence;
}
const admitted = `NOT EXISTS (
  SELECT 1 FROM json_each(json_extract(metadata_json,'$.classification')) WHERE value='internal'
)`;
export const desktopHistorySourceId = (source: string) =>
  NodeCrypto.createHash("sha256").update(source).digest("hex");

/** Durable discovery queue and complete snapshots, separate from upstream event-store migrations. */
export class DesktopHistoryStore {
  private readonly db: NodeSqlite.DatabaseSync;
  private readonly cacheEpoch: string;
  private readonly titleEpoch: string;
  constructor(path: string) {
    this.db = new NodeSqlite.DatabaseSync(path);
    try {
      this.db.exec(`
      PRAGMA busy_timeout=2500;
      CREATE TABLE IF NOT EXISTS history_candidates (
        source TEXT NOT NULL, native_id TEXT NOT NULL, metadata_json TEXT NOT NULL,
        discovered_at INTEGER NOT NULL, attempted_at INTEGER, fetched_at INTEGER,
        snapshot_hash TEXT, error TEXT, PRIMARY KEY(source,native_id)
      );
      CREATE TABLE IF NOT EXISTS history_snapshots (
        source TEXT NOT NULL, native_id TEXT NOT NULL, hash TEXT NOT NULL,
        fetched_at INTEGER NOT NULL, history_json TEXT NOT NULL,
        PRIMARY KEY(source,native_id,hash)
      );
      CREATE TABLE IF NOT EXISTS history_discovery (
        source TEXT NOT NULL, kind TEXT NOT NULL, attempted_at INTEGER NOT NULL,
        error TEXT, PRIMARY KEY(source,kind)
      );
      CREATE TABLE IF NOT EXISTS history_sources (
        configured_home TEXT PRIMARY KEY, verified_source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_title_observations (
        source TEXT NOT NULL, native_id TEXT NOT NULL, revision INTEGER NOT NULL,
        name TEXT NOT NULL, PRIMARY KEY(source,native_id)
      );
    `);
      const columns = new Set(
        this.db
          .prepare("PRAGMA table_info(history_candidates)")
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("read_revision"))
        this.db.exec(
          "ALTER TABLE history_candidates ADD COLUMN read_revision INTEGER NOT NULL DEFAULT 0",
        );
      if (!columns.has("canonical_title"))
        this.db.exec("ALTER TABLE history_candidates ADD COLUMN canonical_title TEXT");
      if (!columns.has("unstable_attempts"))
        this.db.exec(
          "ALTER TABLE history_candidates ADD COLUMN unstable_attempts INTEGER NOT NULL DEFAULT 0",
        );
      if (!columns.has("retry_at"))
        this.db.exec("ALTER TABLE history_candidates ADD COLUMN retry_at INTEGER");
      this.db
        .prepare("INSERT OR IGNORE INTO history_metadata VALUES ('cache_epoch',?)")
        .run(NodeCrypto.randomUUID());
      this.cacheEpoch = String(
        this.db.prepare("SELECT value FROM history_metadata WHERE key='cache_epoch'").get()!.value,
      );
      this.db
        .prepare("INSERT OR IGNORE INTO history_metadata VALUES ('title_epoch',?)")
        .run(NodeCrypto.randomUUID());
      this.titleEpoch = String(
        this.db.prepare("SELECT value FROM history_metadata WHERE key='title_epoch'").get()!.value,
      );
      // Replay classification from pre-existing snapshots without rewriting or deleting their bodies.
      const legacy = this.db.prepare(`SELECT c.source,c.native_id,c.metadata_json,
        json_extract(h.history_json,'$.canonical.thread.source','$.canonical.thread.threadSource',
          '$.canonical.thread.thread_source','$.canonical.thread.ephemeral',
          '$.canonical.thread.parentThreadId','$.canonical.thread.parent_thread_id') AS native_metadata
        FROM history_candidates c JOIN history_snapshots h
        ON h.source=c.source AND h.native_id=c.native_id
        WHERE json_extract(c.metadata_json,'$.classification.canonical') IS NULL`);
      const update = this.db.prepare(
        "UPDATE history_candidates SET metadata_json=? WHERE source=? AND native_id=?",
      );
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const restored = new Map<string, { source: string; metadata: DesktopHistoryCandidate }>();
        for (const row of legacy.iterate()) {
          const metadata = JSON.parse(String(row.metadata_json)) as DesktopHistoryCandidate;
          const key = JSON.stringify([row.source, row.native_id]);
          const [source, threadSource, thread_source, ephemeral, parentThreadId, parent_thread_id] =
            JSON.parse(String(row.native_metadata)) as unknown[];
          restored.set(key, {
            source: String(row.source),
            metadata: {
              ...metadata,
              classification: mergeDesktopHistoryClassification(
                restored.get(key)?.metadata.classification ?? metadata.classification,
                {
                  canonical: classifyDesktopHistory({
                    source,
                    threadSource,
                    thread_source,
                    ephemeral,
                    parentThreadId,
                    parent_thread_id,
                  }),
                },
              ),
            },
          });
        }
        for (const { source, metadata } of restored.values())
          update.run(JSON.stringify(metadata), source, metadata.conversationId);
        this.db.exec("COMMIT");
      } catch (cause) {
        this.db.exec("ROLLBACK");
        throw cause;
      }
    } catch (cause) {
      this.db.close();
      throw cause;
    }
  }
  close() {
    this.db.close();
  }
  observeTitle(source: string, nativeId: string, name: string): CodexNativeTitleRead {
    if (!name.trim()) throw new Error("An explicit native title is required.");
    const row = this.db
      .prepare(`INSERT INTO native_title_observations VALUES (?,?,1,?)
      ON CONFLICT(source,native_id) DO UPDATE SET revision=revision+1,name=excluded.name
      RETURNING revision`)
      .get(source, nativeId, name)!;
    return {
      sourceId: desktopHistorySourceId(source),
      nativeId,
      epoch: this.titleEpoch,
      revision: Number(row.revision),
      name,
    };
  }
  isCurrentTitle(source: string, read: CodexNativeTitleRead): boolean {
    if (read.sourceId !== desktopHistorySourceId(source) || read.epoch !== this.titleEpoch)
      return false;
    const row = this.db
      .prepare("SELECT revision,name FROM native_title_observations WHERE source=? AND native_id=?")
      .get(source, read.nativeId);
    return row?.revision === read.revision && row.name === read.name;
  }
  rememberSource(configuredHome: string, verifiedSource: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO history_sources VALUES (?,?)")
      .run(configuredHome, verifiedSource);
  }
  sourceFor(configuredHome: string): string | null {
    const row = this.db
      .prepare("SELECT verified_source FROM history_sources WHERE configured_home=?")
      .get(configuredHome);
    return row ? String(row.verified_source) : null;
  }
  discoveryResult(
    source: string,
    kind: "local" | "api" | "rollout",
    now: number,
    error: string | null,
  ) {
    this.db
      .prepare("INSERT OR REPLACE INTO history_discovery VALUES (?,?,?,?)")
      .run(source, kind, now, error);
  }
  discoveryStatus(source: string): ReadonlyArray<{
    kind: "local" | "api" | "rollout";
    attemptedAt: number;
    error: string | null;
  }> {
    return this.db
      .prepare("SELECT * FROM history_discovery WHERE source=? ORDER BY kind")
      .all(source)
      .map((row) => ({
        kind: String(row.kind) as "local" | "api" | "rollout",
        attemptedAt: Number(row.attempted_at),
        error: row.error == null ? null : String(row.error),
      }));
  }
  discover(source: string, candidates: ReadonlyArray<DesktopHistoryCandidate>, now: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.db.prepare(`INSERT INTO history_candidates
        (source,native_id,metadata_json,discovered_at) VALUES (?,?,?,?)
        ON CONFLICT(source,native_id) DO UPDATE SET metadata_json=excluded.metadata_json,
        discovered_at=excluded.discovered_at`);
      const previous = this.db.prepare(
        "SELECT metadata_json FROM history_candidates WHERE source=? AND native_id=?",
      );
      for (const candidate of candidates) {
        const row = previous.get(source, candidate.conversationId);
        const metadata = row
          ? (JSON.parse(String(row.metadata_json)) as DesktopHistoryCandidate)
          : undefined;
        statement.run(
          source,
          candidate.conversationId,
          JSON.stringify({
            ...candidate,
            attachedToThreadId: candidate.attachedToThreadId ?? null,
            classification: mergeDesktopHistoryClassification(
              metadata?.classification,
              candidate.classification,
            ),
          }),
          now,
        );
      }
      // Missing pages or source files never erase a previous discovery or cached history.
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }
  pending(
    source: string,
    before: number,
    limit: number,
    now = before,
  ): ReadonlyArray<DesktopHistoryCandidate> {
    return this.db
      .prepare(`SELECT metadata_json FROM history_candidates WHERE source=? AND ${admitted}
      AND (attempted_at IS NULL OR attempted_at <= ? OR retry_at <= ?)
      ORDER BY attempted_at ASC,native_id ASC LIMIT ?`)
      .all(source, before, now, limit)
      .map((row) => JSON.parse(String(row.metadata_json)) as DesktopHistoryCandidate);
  }
  save(source: string, history: CodexHistory, membership: CodexDesktopMembership, now: number) {
    if (
      !history.canonical ||
      history.canonical.consistency !== "observed-stable" ||
      history.canonical.thread.id !== history.nativeThreadId
    )
      throw new Error("A complete canonical history with the original identity is required.");
    const row = this.db
      .prepare("SELECT metadata_json FROM history_candidates WHERE source=? AND native_id=?")
      .get(source, history.nativeThreadId);
    if (!row) throw new Error("Discover the native identity before storing history.");
    const previous = JSON.parse(String(row.metadata_json)) as DesktopHistoryCandidate;
    const native = history.canonical.thread;
    const metadata: DesktopHistoryCandidate = {
      ...previous,
      membership,
      title: typeof native.name === "string" && native.name.trim() ? native.name : previous.title,
      cwd: typeof native.cwd === "string" ? native.cwd : previous.cwd,
      updatedAt: typeof native.updatedAt === "number" ? native.updatedAt : previous.updatedAt,
      classification: mergeDesktopHistoryClassification(previous.classification, {
        canonical: classifyDesktopHistory(native),
      }),
    };
    if (desktopHistoryClassification(metadata.classification) === "internal") {
      this.db
        .prepare(`UPDATE history_candidates SET metadata_json=?,attempted_at=?,retry_at=NULL
          WHERE source=? AND native_id=?`)
        .run(JSON.stringify(metadata), now, source, history.nativeThreadId);
      return;
    }
    const json = JSON.stringify(history);
    const hash = NodeCrypto.createHash("sha256").update(json).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Retain previous snapshots: a rewind, a partial producer view or a failed later read
      // must not irreversibly remove history already available to the user.
      this.db
        .prepare("INSERT OR IGNORE INTO history_snapshots VALUES (?,?,?,?,?)")
        .run(source, history.nativeThreadId, hash, now, json);
      this.db
        .prepare(`UPDATE history_candidates SET metadata_json=?,attempted_at=?,fetched_at=?,
        snapshot_hash=?,error=NULL,read_revision=read_revision+1,canonical_title=?,
        unstable_attempts=0,retry_at=NULL WHERE source=? AND native_id=?`)
        .run(
          JSON.stringify(metadata),
          now,
          now,
          hash,
          typeof native.name === "string" && native.name.trim() ? native.name : null,
          source,
          history.nativeThreadId,
        );
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }
  failed(
    source: string,
    nativeId: string,
    now: number,
    error: string,
    reason?: "changed-during-read",
  ) {
    const unstable = reason === "changed-during-read" ? 1 : 0;
    this.db
      .prepare(
        `UPDATE history_candidates SET attempted_at=?,error=?,
        retry_at=CASE WHEN ? AND unstable_attempts<2 THEN ? + 15000*(unstable_attempts+1) ELSE NULL END
        WHERE source=? AND native_id=?`,
      )
      .run(now, error, unstable, now, source, nativeId);
  }
  claim(source: string, nativeId: string, now: number): boolean {
    // Consume a short retry before I/O; a crash leaves the normal cooldown in place.
    return (
      this.db
        .prepare(`UPDATE history_candidates SET
      unstable_attempts=unstable_attempts+CASE WHEN retry_at IS NOT NULL THEN 1 ELSE 0 END,
      attempted_at=?,retry_at=NULL WHERE source=? AND native_id=? AND ${admitted}
      AND (attempted_at IS NULL OR attempted_at<=? OR retry_at<=?)`)
        .run(now, source, nativeId, now - 300_000, now).changes === 1
    );
  }
  read(source: string, nativeId: string): CodexHistory | null {
    return this.readVersion(source, nativeId)?.history ?? null;
  }
  readVersion(
    source: string,
    nativeId: string,
    hash?: string,
  ): { history: CodexHistory; hash: string } | null {
    if (!this.isAdmitted(source, nativeId)) return null;
    const row =
      hash === undefined
        ? this.db
            .prepare(`SELECT h.history_json,h.hash FROM history_candidates c
      JOIN history_snapshots h ON h.source=c.source AND h.native_id=c.native_id AND h.hash=c.snapshot_hash
      WHERE c.source=? AND c.native_id=?`)
            .get(source, nativeId)
        : this.db
            .prepare(
              "SELECT history_json,hash FROM history_snapshots WHERE source=? AND native_id=? AND hash=?",
            )
            .get(source, nativeId, hash);
    return row
      ? { history: JSON.parse(String(row.history_json)) as CodexHistory, hash: String(row.hash) }
      : null;
  }
  statistics(source: string) {
    // Casting text to BLOB loads every snapshot; octet_length reads its stored byte count.
    const row = this.db
      .prepare(
        "SELECT count(*) AS versions,coalesce(sum(octet_length(history_json)),0) AS bytes FROM history_snapshots WHERE source=?",
      )
      .get(source)!;
    const pages = this.db.prepare("PRAGMA page_count").get()!;
    const size = this.db.prepare("PRAGMA page_size").get()!;
    return {
      sourceVersions: Number(row.versions),
      sourceSnapshotBytes: Number(row.bytes),
      databaseBytes: Number(pages.page_count) * Number(size.page_size),
    };
  }
  isAdmitted(source: string, nativeId: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM history_candidates WHERE source=? AND native_id=? AND ${admitted}`)
      .get(source, nativeId);
  }
  list(source: string): ReadonlyArray<CodexDesktopHistoryEntry> {
    const sourceId = desktopHistorySourceId(source);
    return this.db
      .prepare(`SELECT * FROM history_candidates WHERE source=? AND ${admitted} ORDER BY native_id`)
      .all(source)
      .map((row) => ({
        ...(JSON.parse(String(row.metadata_json)) as DesktopHistoryCandidate),
        classification:
          desktopHistoryClassification(
            (JSON.parse(String(row.metadata_json)) as DesktopHistoryCandidate).classification,
          ) === "interactive"
            ? "interactive"
            : "unknown",
        sourceId,
        status: row.error ? "unavailable" : row.snapshot_hash ? "cached" : "pending",
        fetchedAt: row.fetched_at == null ? null : Number(row.fetched_at),
        error: row.error == null ? null : String(row.error),
        ...(row.canonical_title == null
          ? {}
          : {
              canonicalTitle: {
                cacheEpoch: this.cacheEpoch,
                revision: Number(row.read_revision),
                snapshot: String(row.snapshot_hash),
                name: String(row.canonical_title),
              },
            }),
      }));
  }
}
