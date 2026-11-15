// @effect-diagnostics nodeBuiltinImport:off - Exercises close/reopen of the synchronous SQLite boundary in a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { DesktopHistoryStore, desktopHistorySourceId } from "./DesktopHistoryStore.ts";

it("persists a separate title watermark without changing full-history snapshots or discovery", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-title-watermark-"));
  const path = NodePath.join(directory, "cache.sqlite");
  let store = new DesktopHistoryStore(path);
  try {
    store.discover(
      "home",
      [
        {
          conversationId: "native",
          title: "A",
          cwd: "/fixture",
          archived: false,
          updatedAt: 1,
          membership,
        },
      ],
      1,
    );
    store.save(
      "home",
      {
        nativeThreadId: "native",
        turnIds: ["turn"],
        messages: [],
        omittedItemTypes: [],
        canonical: {
          consistency: "observed-stable",
          thread: { id: "native", name: "A", createdAt: 1, turns: [] },
          turns: [{ id: "turn", items: [{ id: "body", type: "agentMessage", text: "保留 🌿" }] }],
          itemEntries: [],
        },
      },
      membership,
      2,
    );
    expect(store.statistics("home")).toMatchObject({
      sourceVersions: 1,
      sourceSnapshotBytes: Buffer.byteLength(JSON.stringify(store.read("home", "native"))),
    });
    expect(store.statistics("other")).toMatchObject({
      sourceVersions: 0,
      sourceSnapshotBytes: 0,
    });
    const first = store.observeTitle("home", "native", "A");
    expect(store.isCurrentTitle("home", first)).toBe(true);
    const unchanged = store.observeTitle("home", "native", "A");
    expect(unchanged.revision).toBe(2);
    expect(store.isCurrentTitle("home", first)).toBe(false);
    const before = [
      store.list("home"),
      store.read("home", "native"),
      store.statistics("home"),
      store.pending("home", 1, 10),
    ];
    store.close();
    store = new DesktopHistoryStore(path);
    expect(store.isCurrentTitle("home", unchanged)).toBe(true);
    expect(store.isCurrentTitle("home", first)).toBe(false);
    expect(store.isCurrentTitle("other", unchanged)).toBe(false);
    expect(store.isCurrentTitle("home", { ...unchanged, epoch: "old" })).toBe(false);
    expect(store.isCurrentTitle("home", { ...unchanged, name: "late B" })).toBe(false);
    const second = store.observeTitle("home", "native", "B");
    expect(second).toMatchObject({ ...first, name: "B", revision: 3 });
    expect(store.isCurrentTitle("home", unchanged)).toBe(false);
    expect(store.isCurrentTitle("home", second)).toBe(true);
    expect([
      store.list("home"),
      store.read("home", "native"),
      store.statistics("home"),
      store.pending("home", 1, 10),
    ]).toEqual(before);
    expect(store.observeTitle("other", "native", "C").revision).toBe(1);
    expect(() => store.observeTitle("home", "native", " ")).toThrow();
  } finally {
    store.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
import { desktopHistoryMembership } from "./DesktopHistoryMembership.ts";
import type { CodexHistory } from "../project/CodexSessionHistory.ts";
import { discoverDesktopHistory } from "./DesktopHistoryDiscovery.ts";
import { resolveDesktopHistorySource } from "./DesktopHistorySourceScope.ts";
import { readDesktopHistoryCandidates } from "./DesktopHistorySource.ts";
import { readDesktopRolloutCandidates } from "./DesktopRolloutDiscovery.ts";
import { CodexDesktopError } from "@t3tools/contracts";
import { desktopHistoryPage } from "./DesktopHistoryPage.ts";
const testFailure = (message: string) => new CodexDesktopError({ message, outcomeUnknown: false });

const membership = {
  kind: "none",
  projectId: null,
  projectTitle: null,
  source: "desktop-cache",
} as const;

it.effect.each(["both", "local-unavailable", "rollout-unavailable", "api-first"])(
  "retains internal discovery evidence when the API omits classification (%s)",
  (available) =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-classification-"));
      const cachePath = NodePath.join(directory, "cache.sqlite");
      let store = new DesktopHistoryStore(cachePath);
      try {
        const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, "state_5.sqlite"));
        try {
          db.exec(
            "CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,archived INTEGER,updated_at INTEGER,source TEXT,thread_source TEXT)",
          );
          db.prepare("INSERT INTO threads VALUES (?,?,?,0,1,?,?)").run(
            "ambient",
            "Internal",
            directory,
            "vscode",
            "ambient_suggestions",
          );
        } finally {
          db.close();
        }
        NodeFS.mkdirSync(NodePath.join(directory, "sessions"));
        NodeFS.writeFileSync(
          NodePath.join(directory, "sessions", "rollout-ambient.jsonl"),
          JSON.stringify({
            type: "session_meta",
            payload: {
              id: "ambient",
              cwd: directory,
              source: "vscode",
              thread_source: "ambient_suggestions",
            },
          }) + "\n",
        );
        const api = Effect.succeed([
          {
            conversationId: "ambient",
            title: "Internal",
            cwd: directory,
            archived: false,
            updatedAt: 1,
            membership,
          },
        ]);
        if (available === "api-first") {
          yield* discoverDesktopHistory({
            store,
            source: directory,
            now: 0,
            api,
            local: Effect.fail(testFailure("Index temporarily unavailable")),
          });
          expect(store.list(directory).map((row) => row.conversationId)).toEqual(["ambient"]);
        }
        yield* discoverDesktopHistory({
          store,
          source: directory,
          now: 1,
          api,
          local:
            available === "local-unavailable"
              ? Effect.fail(testFailure("Index temporarily unavailable"))
              : Effect.sync(() => readDesktopHistoryCandidates(directory, {})),
          rollouts:
            available === "rollout-unavailable"
              ? Effect.fail(testFailure("Rollouts temporarily unavailable"))
              : Effect.tryPromise({
                  try: () => readDesktopRolloutCandidates(directory, {}),
                  catch: () => testFailure("Fixture rollout read failed"),
                }),
        });
        expect(store.list(directory)).toEqual([]);
        expect(store.pending(directory, 10, 10)).toEqual([]);
        store.close();
        store = new DesktopHistoryStore(cachePath);
        yield* discoverDesktopHistory({
          store,
          source: directory,
          now: 2,
          api,
          local: Effect.fail(testFailure("Index temporarily unavailable")),
        });
        expect(store.list(directory)).toEqual([]);
        expect(store.pending(directory, 10, 10)).toEqual([]);
      } finally {
        store.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
);

it.each([
  { threadSource: "ambient_suggestions" },
  { source: { subAgent: { other: "guardian" } } },
  { ephemeral: true },
])(
  "quarantines canonical internal metadata while retaining snapshots and other sources (%j)",
  (internal) => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-canonical-classification-"),
    );
    const cachePath = NodePath.join(directory, "cache.sqlite");
    let store = new DesktopHistoryStore(cachePath);
    try {
      const candidate = {
        conversationId: "native",
        title: "Saved",
        cwd: directory,
        archived: false,
        updatedAt: 1,
        membership,
        classification: { api: "unknown" as const },
      };
      const history: CodexHistory = {
        nativeThreadId: "native",
        messages: [],
        omittedItemTypes: [],
        canonical: {
          consistency: "observed-stable",
          thread: { id: "native", createdAt: 1, turns: [], source: "unknown" },
          turns: [
            { id: "turn", items: [{ id: "answer", type: "agentMessage", text: "Preserve" }] },
          ],
          itemEntries: [],
        },
      };
      for (const source of ["a", "b"]) {
        store.discover(source, [candidate], 1);
        store.save(source, history, membership, 2);
        expect(store.list(source)[0]?.classification).toBe("unknown");
        expect(store.read(source, "native")).toEqual(history);
      }
      const versions = store.statistics("a").sourceVersions;
      store.save(
        "a",
        {
          ...history,
          canonical: {
            ...history.canonical!,
            thread: { ...history.canonical!.thread, ...internal },
          },
        },
        membership,
        3,
      );
      expect(store.statistics("a").sourceVersions).toBe(versions);
      expect(store.read("a", "native")).toBeNull();
      expect(store.list("a")).toEqual([]);
      expect(store.pending("a", 1_000_000, 10)).toEqual([]);
      expect(store.claim("a", "native", 1_000_000)).toBe(false);
      store.close();
      store = new DesktopHistoryStore(cachePath);
      store.discover("a", [{ ...candidate, classification: { api: "interactive" } }], 4);
      store.save("a", history, membership, 5);
      expect(store.isAdmitted("a", "native")).toBe(false);
      expect(store.read("b", "native")).toEqual(history);
      expect(store.statistics("a").sourceVersions).toBe(versions);
      store.discover("b", [{ ...candidate, classification: { local: "interactive" } }], 6);
      store.discover("b", [candidate], 7);
      store.discover("b", [{ ...candidate, classification: { local: "unknown" } }], 8);
      expect(store.list("b")[0]?.classification).toBe("interactive");
      const db = new NodeSqlite.DatabaseSync(cachePath, { readOnly: true });
      try {
        expect(
          JSON.parse(
            String(
              db.prepare("SELECT history_json FROM history_snapshots WHERE source='a'").get()!
                .history_json,
            ),
          ),
        ).toEqual(history);
      } finally {
        db.close();
      }
    } finally {
      store.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("replays internal classification from a legacy cached snapshot without erasing it", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-legacy-classification-"));
  const cachePath = NodePath.join(directory, "cache.sqlite");
  let store = new DesktopHistoryStore(cachePath);
  try {
    store.discover(
      "a",
      [
        {
          conversationId: "native",
          title: "Old",
          cwd: "",
          archived: false,
          updatedAt: 1,
          membership,
        },
      ],
      1,
    );
    const history: CodexHistory = {
      nativeThreadId: "native",
      messages: [],
      omittedItemTypes: [],
      canonical: {
        consistency: "observed-stable",
        thread: { id: "native", createdAt: 1, turns: [] },
        turns: [],
        itemEntries: [],
      },
    };
    store.save("a", history, membership, 2);
    store.save(
      "a",
      {
        ...history,
        canonical: {
          ...history.canonical!,
          thread: { ...history.canonical!.thread, name: "Later metadata omits classification" },
        },
      },
      membership,
      3,
    );
    store.close();
    const db = new NodeSqlite.DatabaseSync(cachePath);
    let body: string;
    let snapshot: string;
    try {
      db.exec(
        "UPDATE history_candidates SET metadata_json=json_remove(metadata_json,'$.classification')",
      );
      body = JSON.stringify({
        ...history,
        canonical: {
          ...history.canonical!,
          thread: { ...history.canonical!.thread, threadSource: "ambient_suggestions" },
        },
      });
      db.prepare("UPDATE history_snapshots SET history_json=?,hash=? WHERE fetched_at=2").run(
        body,
        NodeCrypto.createHash("sha256").update(body).digest("hex"),
      );
      snapshot = String(
        db.prepare("SELECT snapshot_hash FROM history_candidates").get()!.snapshot_hash,
      );
    } finally {
      db.close();
    }
    store = new DesktopHistoryStore(cachePath);
    expect(store.list("a")).toEqual([]);
    expect(store.pending("a", 100, 10)).toEqual([]);
    expect(store.readVersion("a", "native", snapshot)).toBeNull();
    expect(store.statistics("a").sourceVersions).toBe(2);
    const after = new NodeSqlite.DatabaseSync(cachePath, { readOnly: true });
    try {
      expect(
        after.prepare("SELECT history_json FROM history_snapshots WHERE fetched_at=2").get()!
          .history_json,
      ).toBe(body);
    } finally {
      after.close();
    }
  } finally {
    store.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
it("resumes a durable queue beyond 100 and retains canonical history after source failure and disappearance", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-history-library-"));
  const path = NodePath.join(directory, "library.sqlite");
  let store = new DesktopHistoryStore(path);
  try {
    const candidates = Array.from({ length: 205 }, (_, i) => ({
      conversationId: `id-${String(i).padStart(3, "0")}`,
      title: `Old ${i}`,
      cwd: "",
      archived: i === 0,
      updatedAt: 1,
      membership,
    }));
    store.discover("home-a", candidates, 1);
    for (const candidate of store.pending("home-a", 1, 100))
      store.failed("home-a", candidate.conversationId, 2, "offline");
    expect(store.pending("home-a", 1, 100)[0]?.conversationId).toBe("id-100");
    const history: CodexHistory = {
      nativeThreadId: "id-000",
      turnIds: ["turn"],
      messages: [],
      omittedItemTypes: ["future"],
      canonical: {
        consistency: "observed-stable",
        thread: {
          id: "id-000",
          createdAt: 1,
          turns: [],
          path: "missing.jsonl",
          forkedFromId: "parent",
        },
        turns: [
          { id: "turn", items: [{ id: "item", type: "future", payload: { all: [1, 2, 3] } }] },
        ],
        itemEntries: [],
      },
    };
    store.save("home-a", history, membership, 3);
    store.close();
    store = new DesktopHistoryStore(path);
    store.discover("home-a", [], 4);
    store.failed("home-a", "id-000", 5, "Source unavailable");
    expect(store.list("home-a")).toHaveLength(205);
    expect(store.list("home-a")[0]).toMatchObject({
      archived: true,
      fetchedAt: 3,
      status: "unavailable",
    });
    expect(store.read("home-a", "id-000")).toEqual(history);
    expect(store.read("home-b", "id-000")).toBeNull();
    expect(store.list("home-b")).toEqual([]);
    store.failed("home-a", "id-000", 10, "unstable", "changed-during-read");
    const due = (now: number) =>
      store
        .pending("home-a", now - 300_000, 300, now)
        .some((row) => row.conversationId === "id-000");
    expect(due(15_009)).toBe(false);
    store.close();
    store = new DesktopHistoryStore(path);
    expect(due(15_010)).toBe(true);
    expect(store.claim("home-a", "id-000", 15_010)).toBe(true);
    store.failed("home-a", "id-000", 15_010, "unstable", "changed-during-read");
    expect(due(45_009)).toBe(false);
    expect(due(45_010)).toBe(true);
    expect(store.claim("home-a", "id-000", 45_010)).toBe(true);
    store.failed("home-a", "id-000", 45_010, "unstable", "changed-during-read");
    expect(due(345_009)).toBe(false);
    expect(due(345_010)).toBe(true);
    expect(store.read("home-a", "id-000")).toEqual(history);
    store.failed("home-a", "id-000", 345_010, "RPC failed");
    store.discover("home-a", candidates, 345_011);
    store.failed("home-a", "id-000", 645_010, "unstable", "changed-during-read");
    expect(due(660_010)).toBe(false);
    store.save("home-a", history, membership, 945_010);
    store.failed("home-a", "id-000", 945_011, "unstable", "changed-during-read");
    expect(due(960_011)).toBe(true);
    expect(store.claim("home-a", "id-000", 960_011)).toBe(true);
    store.close();
    store = new DesktopHistoryStore(path);
    expect(store.claim("home-a", "id-000", 960_012)).toBe(false);
    expect(due(1_260_010)).toBe(false);
    expect(store.claim("home-a", "id-000", 1_260_011)).toBe(true);
    store.failed("home-a", "id-000", 1_260_011, "unstable", "changed-during-read");
    expect(due(1_275_011)).toBe(false);
    expect(store.claim("home-a", "id-000", 1_290_011)).toBe(true);
    store.close();
    store = new DesktopHistoryStore(path);
    expect(due(1_290_012)).toBe(false);
    expect(store.read("home-a", "id-000")).toEqual(history);
  } finally {
    store.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("preserves explicit projectless and conflicting evidence without inferring membership from cwd", () => {
  const cache = {
    "projectless-thread-ids": ["none", "conflict"],
    "thread-project-assignments": {
      assigned: { projectKind: "local", projectId: "p" },
      conflict: { projectKind: "local", projectId: "p" },
      remote: { projectKind: "local", projectId: "p" },
    },
    "thread-project-membership-host-ids": { remote: "other-host" },
    "local-projects": { p: { id: "p", name: "Desktop project", rootPaths: ["/shared-directory"] } },
  };
  expect(desktopHistoryMembership("none", null, cache)).toEqual(membership);
  expect(desktopHistoryMembership("assigned", null, cache)).toMatchObject({
    kind: "assigned",
    projectId: "p",
    source: "desktop-cache",
  });
  expect(desktopHistoryMembership("conflict", null, cache)).toMatchObject({
    kind: "unknown",
    source: "conflict",
  });
  expect(desktopHistoryMembership("remote", null, cache)).toMatchObject({
    kind: "unknown",
    source: "conflict",
  });
  expect(desktopHistoryMembership("unlisted", null, cache)).toMatchObject({
    kind: "unknown",
    source: "unavailable",
  });
  expect(desktopHistoryMembership("conflict", "authoritative", cache)).toMatchObject({
    kind: "assigned",
    projectId: "authoritative",
    source: "native",
  });
});

it.effect(
  "keeps known IDs refreshable after list failure and discards discovery on source drift",
  () =>
    Effect.gen(function* () {
      const store = new DesktopHistoryStore(":memory:");
      try {
        const candidate = {
          conversationId: "old",
          title: "Old",
          cwd: "/preserve-workspace",
          attachedToThreadId: "parent",
          archived: false,
          updatedAt: 1,
          membership,
        };
        yield* discoverDesktopHistory({
          store,
          source: "a",
          now: 1,
          local: Effect.succeed([candidate]),
          api: Effect.fail(testFailure("List page failed")),
        });
        expect(store.pending("a", 1, 10).map((row) => row.conversationId)).toEqual(["old"]);
        expect(store.discoveryStatus("a")).toContainEqual({
          kind: "api",
          attemptedAt: 1,
          error: "List page failed",
        });
        yield* discoverDesktopHistory({
          store,
          source: "a",
          now: 2,
          mayCommit: Effect.succeed(false),
          local: Effect.succeed([{ ...candidate, conversationId: "wrong-source" }]),
          api: Effect.fail(testFailure("Changed")),
        });
        expect(store.list("a").map((row) => row.conversationId)).toEqual(["old"]);
        expect(store.discoveryStatus("a").every((row) => row.attemptedAt === 1)).toBe(true);
        store.save(
          "a",
          {
            nativeThreadId: "old",
            messages: [],
            omittedItemTypes: [],
            canonical: {
              consistency: "observed-stable",
              thread: { id: "old", name: "Canonical saved title", createdAt: 1, turns: [] },
              turns: [],
              itemEntries: [],
            },
          },
          membership,
          3,
        );
        const cached = store.read("a", "old");
        yield* discoverDesktopHistory({
          store,
          source: "a",
          now: 4,
          rollouts: Effect.succeed({
            rows: [{ ...candidate, title: "Untitled", cwd: "", attachedToThreadId: null }],
            error: null,
          }),
          local: Effect.fail(testFailure("Index unavailable")),
          api: Effect.fail(testFailure("API unavailable")),
        });
        expect(store.list("a")[0]).toMatchObject({
          title: "Canonical saved title",
          cwd: "/preserve-workspace",
          attachedToThreadId: "parent",
        });
        expect(store.read("a", "old")).toEqual(cached);
      } finally {
        store.close();
      }
    }),
);

it.effect.each(["NotFound", "AccessDenied"])(
  "uses only the same verified offline source after reopen: %s",
  (error) =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-history-offline-"));
      const path = NodePath.join(directory, "cache.sqlite");
      let store = new DesktopHistoryStore(path);
      try {
        yield* resolveDesktopHistorySource({
          configuredHome: "/alias-a",
          realPath: Effect.succeed("/physical-a"),
          store,
        });
        store.close();
        store = new DesktopHistoryStore(path);
        const offline = yield* resolveDesktopHistorySource({
          configuredHome: "/alias-a",
          realPath: Effect.fail(testFailure(error)),
          store,
        });
        expect(offline).toMatchObject({ source: "/physical-a", available: false });
        const other = yield* resolveDesktopHistorySource({
          configuredHome: "/alias-b",
          realPath: Effect.fail(testFailure(error)),
          store,
        }).pipe(Effect.exit);
        expect(Exit.isFailure(other)).toBe(true);
      } finally {
        store.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
);

it("rotates past continuously dirty earlier identities and preserves attached and compressed source candidates", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-history-source-"));
  const store = new DesktopHistoryStore(":memory:");
  try {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      conversationId: `id-${String(i).padStart(2, "0")}`,
      title: "Old",
      cwd: "",
      archived: false,
      updatedAt: 1,
      membership,
    }));
    store.discover("a", rows, 1);
    const visited = new Set<string>();
    for (let cycle = 2; cycle <= 7; cycle++) {
      store.discover(
        "a",
        rows.slice(0, 40).map((row) => ({ ...row, title: `Changed ${cycle}`, updatedAt: cycle })),
        cycle,
      );
      for (const row of store.pending("a", cycle, 10)) {
        visited.add(row.conversationId);
        store.failed("a", row.conversationId, cycle, "retry");
      }
    }
    expect(visited.size).toBe(50);
    const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, "state_5.sqlite"));
    try {
      db.exec(
        "CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,archived INTEGER,updated_at INTEGER,source TEXT,attached_thread_parent_id TEXT,rollout_path TEXT)",
      );
      const insert = db.prepare("INSERT INTO threads VALUES (?,?,?,0,1,?,?,?)");
      insert.run("old", "Old", "", "vscode", null, "missing.jsonl");
      insert.run("attached", "Child", "", "vscode", "old", "missing.jsonl.zst");
      insert.run(
        "guardian",
        "Internal",
        "",
        '{"subagent":{"other":"guardian"}}',
        null,
        "missing.jsonl",
      );
      insert.run(
        "camel",
        "Internal",
        "",
        '{"subAgent":{"other":"guardian"}}',
        null,
        "missing.jsonl",
      );
      insert.run("unknown", "Old custom", "", "unknown", null, "missing.jsonl");
    } finally {
      db.close();
    }
    const candidates = readDesktopHistoryCandidates(directory, {});
    expect(
      candidates
        .filter((row) => row.classification?.local !== "internal")
        .map((row) => row.conversationId),
    ).toEqual(["attached", "old", "unknown"]);
    expect(
      candidates
        .filter((row) => row.classification?.local === "internal")
        .map((row) => row.conversationId),
    ).toEqual(["camel", "guardian"]);
    expect(candidates[0]?.attachedToThreadId).toBe("old");
  } finally {
    store.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("continues an immutable history page after a newer snapshot and process reopen", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-history-pages-"));
  const path = NodePath.join(directory, "cache.sqlite");
  let store = new DesktopHistoryStore(path);
  try {
    store.discover(
      "a",
      [
        {
          conversationId: "native",
          title: "Old",
          cwd: "",
          archived: false,
          updatedAt: 1,
          membership,
        },
      ],
      1,
    );
    const history = {
      nativeThreadId: "native",
      messages: [],
      omittedItemTypes: [],
      canonical: {
        consistency: "observed-stable" as const,
        thread: { id: "native", name: "Canonical name", createdAt: 1, turns: [] },
        itemEntries: [],
        turns: [
          {
            id: "turn",
            items: Array.from({ length: 30 }, (_, i) => ({
              id: `a-${i}`,
              type: i === 12 ? "reasoning" : "future",
              payload: i === 12 ? ["reasoning".repeat(256 * 1024)] : [i],
            })),
          },
        ],
      },
    };
    store.save("a", history, membership, 2);
    const first = desktopHistoryPage(store, "a", {
      conversationId: "native",
      sourceId: desktopHistorySourceId("a"),
    });
    expect(first.entries).toHaveLength(25);
    expect(first.entries[12]?.item).toEqual(history.canonical.turns[0]?.items[12]);
    const titleRead = store.list("a")[0]?.canonicalTitle;
    expect(titleRead?.name).toBe("Canonical name");
    expect(titleRead?.revision).toBe(1);
    const cursor = first.nextCursor!;
    store.save(
      "a",
      { ...history, canonical: { ...history.canonical, turns: [{ id: "turn-b", items: [] }] } },
      membership,
      3,
    );
    store.close();
    store = new DesktopHistoryStore(path);
    expect(store.list("a")[0]?.canonicalTitle?.cacheEpoch).toBe(titleRead?.cacheEpoch);
    expect(store.list("a")[0]?.canonicalTitle?.revision).toBe(2);
    const second = desktopHistoryPage(store, "a", {
      conversationId: "native",
      sourceId: desktopHistorySourceId("a"),
      cursor,
    });
    expect(second.entries.map((entry) => entry.item?.id)).toEqual([
      "a-25",
      "a-26",
      "a-27",
      "a-28",
      "a-29",
    ]);
    expect(second.nextCursor).toBeNull();
    expect(() =>
      desktopHistoryPage(store, "a", {
        conversationId: "native",
        sourceId: desktopHistorySourceId("a"),
        cursor: { ...cursor, snapshot: "0".repeat(64) },
      }),
    ).toThrow("snapshot is unavailable");
    expect(() =>
      desktopHistoryPage(store, "b", {
        conversationId: "native",
        sourceId: desktopHistorySourceId("a"),
        cursor,
      }),
    ).toThrow("snapshot is unavailable");
  } finally {
    store.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it.effect("recovers a later cycle from synchronous cache write errors", () =>
  Effect.gen(function* () {
    class FlakyStore extends DesktopHistoryStore {
      failDiscover = true;
      failSource = true;
      override discover(...input: Parameters<DesktopHistoryStore["discover"]>) {
        if (this.failDiscover) {
          this.failDiscover = false;
          throw new Error("busy");
        }
        super.discover(...input);
      }
      override rememberSource(...input: Parameters<DesktopHistoryStore["rememberSource"]>) {
        if (this.failSource) {
          this.failSource = false;
          throw new Error("disk unavailable");
        }
        super.rememberSource(...input);
      }
    }
    const store = new FlakyStore(":memory:");
    try {
      const source = resolveDesktopHistorySource({
        store,
        configuredHome: "/a",
        realPath: Effect.succeed("/a"),
      });
      const failed = yield* Effect.result(source);
      expect(failed._tag).toBe("Failure");
      expect((yield* source).source).toBe("/a");
      const local = Effect.succeed([
        {
          conversationId: "native",
          title: "Old",
          cwd: "",
          archived: false,
          updatedAt: 1,
          membership,
        },
      ]);
      yield* discoverDesktopHistory({ store, source: "a", now: 1, local, api: Effect.succeed([]) });
      expect(store.discoveryStatus("a").find((row) => row.kind === "local")?.error).toContain(
        "cache could not be updated",
      );
      yield* discoverDesktopHistory({ store, source: "a", now: 2, local, api: Effect.succeed([]) });
      expect(store.list("a").map((row) => row.conversationId)).toEqual(["native"]);
      expect(store.discoveryStatus("a").every((row) => row.error === null)).toBe(true);
    } finally {
      store.close();
    }
  }),
);
