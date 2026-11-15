// @effect-diagnostics nodeBuiltinImport:off - Isolated native metadata files; no native database is opened for writing.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { expect, it, vi } from "vite-plus/test";
import { readDesktopRolloutCandidates } from "./DesktopRolloutDiscovery.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

it("discovers metadata IDs across unindexed plain/compressed fragments and archives without reading bodies", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-rollout-discovery-"));
  try {
    const active = NodePath.join(home, "sessions", "2026", "11", "13");
    const archive = NodePath.join(home, "archived_sessions");
    await NodeFSP.mkdir(active, { recursive: true });
    await NodeFSP.mkdir(archive);
    const expected = new Set(Array.from({ length: 205 }, (_, i) => `native-${i}`));
    for (let i = 0; i < 205; i++) {
      const metadata = {
        id: `native-${i}`,
        session_id: "shared-root-thread",
        timestamp: "2026-11-13T00:00:00Z",
        cwd: home,
        source: i % 3 ? "vscode" : "unknown",
        ...(i === 7 ? { attached_thread: true, forked_from_id: "native-0" } : {}),
      };
      const text = JSON.stringify({ type: "session_meta", payload: metadata }) + "\n";
      await NodeFSP.writeFile(
        NodePath.join(
          i >= 200 ? archive : active,
          `rollout-filename-is-not-native-${i}.jsonl${i % 2 ? ".zst" : ""}`,
        ),
        i % 2
          ? NodeZlib.zstdCompressSync(text + "body deliberately not JSON\n")
          : text + "body deliberately not JSON\n",
      );
    }
    await NodeFSP.writeFile(
      NodePath.join(active, "rollout-second-fragment.jsonl.zst"),
      NodeZlib.zstdCompressSync(
        JSON.stringify({
          type: "session_meta",
          payload: { id: "native-0", source: "vscode", cwd: home },
        }) + "\n",
      ),
    );
    await NodeFSP.writeFile(
      NodePath.join(active, "rollout-internal.jsonl"),
      JSON.stringify({
        type: "session_meta",
        payload: { id: "internal", source: { subagent: { other: "guardian" } } },
      }) + "\n",
    );
    const result = await readDesktopRolloutCandidates(home, {});
    expect(result.error).toBeNull();
    expect(
      new Set(
        result.rows
          .filter((row) => row.classification?.rollout !== "internal")
          .map((row) => row.conversationId),
      ),
    ).toEqual(expected);
    expect(result.rows).toHaveLength(206);
    expect(result.rows.find((row) => row.conversationId === "internal")?.classification).toEqual({
      rollout: "internal",
    });
    expect(result.rows.filter((row) => row.archived)).toHaveLength(5);
    expect(result.rows.find((row) => row.conversationId === "native-7")?.attachedToThreadId).toBe(
      "native-0",
    );
    // One oversized/corrupt header does not discard other candidates or report a complete scan.
    await NodeFSP.writeFile(
      NodePath.join(active, "rollout-bounded.jsonl.zst"),
      NodeZlib.zstdCompressSync("x".repeat(1024 * 1024 + 1) + "\n"),
    );
    await NodeFSP.writeFile(NodePath.join(active, "rollout-broken.jsonl"), "partial");
    const partial = await readDesktopRolloutCandidates(home, {});
    expect(
      new Set(
        partial.rows
          .filter((row) => row.classification?.rollout !== "internal")
          .map((row) => row.conversationId),
      ),
    ).toEqual(expected);
    expect(partial.error).toContain("2 rollout metadata entries");
    const skippedFrame = Buffer.alloc(8 * 1024 * 1024 + 32);
    skippedFrame.writeUInt32LE(0x184d2a50, 0);
    skippedFrame.writeUInt32LE(skippedFrame.length - 8, 4);
    await NodeFSP.writeFile(
      NodePath.join(active, "rollout-no-decoded-output.jsonl.zst"),
      skippedFrame,
    );
    await NodeFSP.symlink(active, NodePath.join(archive, "skipped-link"), "junction");
    const streamMock = vi.mocked(NodeFS.createReadStream);
    const open = streamMock.getMockImplementation()!;
    const boundedStreams: NodeFS.ReadStream[] = [];
    streamMock.mockImplementation((path, options) => {
      const stream = open(path, options);
      if (String(path).endsWith("rollout-no-decoded-output.jsonl.zst")) boundedStreams.push(stream);
      return stream;
    });
    const bounded = await readDesktopRolloutCandidates(home, {}).finally(() =>
      streamMock.mockImplementation(open),
    );
    await Promise.all(
      boundedStreams.map((stream) =>
        stream.closed
          ? Promise.resolve()
          : new Promise<void>((resolve) => stream.once("close", resolve)),
      ),
    );
    expect(boundedStreams).toHaveLength(1);
    expect(boundedStreams[0]!.bytesRead).toBeLessThanOrEqual(4 * 1024 * 1024 + 64 * 1024);
    expect(
      new Set(
        bounded.rows
          .filter((row) => row.classification?.rollout !== "internal")
          .map((row) => row.conversationId),
      ),
    ).toEqual(expected);
    expect(bounded.error).toContain("4 rollout metadata entries");
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
