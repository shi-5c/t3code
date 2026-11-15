import { assert, it } from "@effect/vitest";
import {
  AgentSessionScanError,
  ProjectId,
  ThreadId,
  type AgentSessionImportInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { TestClock } from "effect/testing";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as NativeSharedSync from "./NativeSharedSync.ts";

it.effect(
  "refreshes existing exact bindings without a Web client and keeps polling after a read failure",
  () =>
    Effect.gen(function* () {
      const calls = yield* Queue.unbounded<AgentSessionImportInput>();
      const rows = ["default", "existing", "ordinary", "archived"].map((id) => ({
        projectId: ProjectId.make(id),
        title: id,
        workspaceRoot: `/workspace/${id}`,
        defaultThreadType:
          id === "default" || id === "archived" ? ("codex-shared" as const) : ("t3" as const),
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        pinnedAt: null,
        archivedAt: id === "archived" ? "2026-09-01T00:00:00.000Z" : null,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        deletedAt: null,
      }));
      yield* Layer.build(
        NativeSharedSync.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectStore.ProjectStoreV2)({ list: () => Effect.succeed(rows) }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                listSharedNativeThreads: () =>
                  Effect.succeed([
                    {
                      projectId: ProjectId.make("existing"),
                      threadId: ThreadId.make("existing-shared"),
                    },
                  ]),
              }),
              Layer.mock(AgentSessionImporter.AgentSessionImporter)({
                importRecentAgentThreads: (input) =>
                  Queue.offer(calls, input).pipe(
                    Effect.andThen(
                      input.projectId === "existing"
                        ? Effect.fail(
                            new AgentSessionScanError({
                              operation: "read-projects",
                              cause: "One project is unavailable",
                            }),
                          )
                        : Effect.succeed({ importedCount: 1, skippedCount: 0 }),
                    ),
                  ),
              }),
            ),
          ),
        ),
      );
      const first = yield* Queue.take(calls);
      assert.strictEqual(first.threadId, "existing-shared");
      assert.isUndefined(first.discoverOnly);
      yield* TestClock.adjust("20 seconds");
      assert.deepEqual((yield* Queue.take(calls)).threadId, "existing-shared");
    }).pipe(Effect.scoped),
);
