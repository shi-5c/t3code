// @effect-diagnostics nodeBuiltinImport:off - Bounded, read-only rollout metadata discovery.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { record, string } from "./protocol.ts";
import {
  classifyDesktopHistory,
  mergeDesktopHistoryClassification,
} from "./DesktopHistoryClassification.ts";
import { desktopHistoryMembership } from "./DesktopHistoryMembership.ts";
import type { DesktopHistoryCandidate } from "./DesktopHistoryStore.ts";

const headerLimit = 1024 * 1024;

async function readMetadata(file: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const input = NodeFS.createReadStream(file, { highWaterMark: 64 * 1024, signal });
  const decoded = file.endsWith(".zst") ? input.pipe(NodeZlib.createZstdDecompress()) : input;
  input.on("error", (error) => decoded.destroy(error));
  input.on("data", () => {
    if (input.bytesRead > 4 * headerLimit)
      input.destroy(new Error("Compressed rollout header exceeds the input budget."));
  });
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of decoded) {
      const bytes = chunk as Buffer;
      const end = bytes.indexOf(10);
      const part = end < 0 ? bytes : bytes.subarray(0, end);
      size += part.length;
      if (size > headerLimit || input.bytesRead > 4 * headerLimit)
        throw new Error("Rollout metadata exceeds the bounded header reader.");
      parts.push(part);
      if (end >= 0) {
        const header = record(JSON.parse(Buffer.concat(parts).toString("utf8")));
        if (header.type !== "session_meta") throw new Error("Rollout has no session metadata.");
        return record(header.payload);
      }
    }
    throw new Error("Rollout metadata is incomplete.");
  } finally {
    decoded.destroy();
    input.destroy();
  }
}

/** File names identify storage fragments, not necessarily native threads. Only metadata supplies IDs. */
export async function readDesktopRolloutCandidates(
  home: string,
  cache: unknown,
  signal?: AbortSignal,
): Promise<{ rows: ReadonlyArray<DesktopHistoryCandidate>; error: string | null }> {
  const candidates = new Map<string, DesktopHistoryCandidate>();
  let unreadable = 0;
  const visit = async (directory: string, archived: boolean, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    let entries: NodeFS.Dirent[];
    try {
      const stat = await NodeFSP.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        unreadable += 1;
        return;
      }
      entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") unreadable += 1;
      return;
    }
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.isSymbolicLink()) {
        unreadable += 1;
        continue;
      }
      const file = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 8) await visit(file, archived, depth + 1);
        else unreadable += 1;
        continue;
      }
      if (!entry.isFile() || !/^rollout-.*\.jsonl(?:\.zst)?$/.test(entry.name)) continue;
      try {
        const metadata = await readMetadata(file, signal);
        const id = string(metadata.id);
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Missing native identity.");
        const attachedParent =
          metadata.attached_thread === true ? string(metadata.forked_from_id) : null;
        if (metadata.attached_thread === true && !attachedParent)
          throw new Error("Attached rollout has no verified parent.");
        const previous = candidates.get(id);
        candidates.set(id, {
          conversationId: id,
          title: "Untitled",
          cwd: string(metadata.cwd),
          archived: archived && (previous?.archived ?? true),
          updatedAt: Math.max(
            previous?.updatedAt ?? 0,
            Date.parse(string(metadata.timestamp)) / 1000 || 0,
          ),
          attachedToThreadId: attachedParent || previous?.attachedToThreadId || null,
          classification: mergeDesktopHistoryClassification(previous?.classification, {
            rollout: classifyDesktopHistory(metadata),
          }),
          membership: desktopHistoryMembership(
            id,
            metadata.project_id ?? metadata.projectId,
            cache,
          ),
        });
      } catch {
        signal?.throwIfAborted();
        unreadable += 1;
      }
    }
  };
  await visit(NodePath.join(home, "sessions"), false, 0);
  await visit(NodePath.join(home, "archived_sessions"), true, 0);
  return {
    rows: [...candidates.values()],
    error: unreadable
      ? `${unreadable} rollout metadata entries could not be read. Discovery will retry; cached history is retained.`
      : null,
  };
}
