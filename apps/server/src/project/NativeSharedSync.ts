import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { forkParked } from "../serverActivation.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  let lastThreadId = "";
  return Effect.fn("NativeSharedSync.reconcile")(function* () {
    const activeProjects = (yield* projects.list()).filter(
      (project) => project.deletedAt === null && project.archivedAt === null,
    );
    const shared = (yield* projections.listSharedNativeThreads()).filter((thread) =>
      activeProjects.some((project) => project.projectId === thread.projectId),
    );
    const start = Math.max(
      0,
      shared.findIndex((thread) => thread.threadId > lastThreadId),
    );
    const selected = [...shared.slice(start), ...shared.slice(0, start)].slice(0, 10);
    for (const thread of selected) {
      // A file fingerprint cannot prove that an independent reader saw the last
      // saved item. Rotate existing shared bindings even when the file is unchanged.
      yield* importer
        .importRecentAgentThreads({ projectId: thread.projectId, threadId: thread.threadId })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Native shared refresh failed", { threadId: thread.threadId, cause }),
          ),
        );
      lastThreadId = thread.threadId;
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reconcile = yield* make;
    const tick = reconcile().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Native shared sync failed", { cause })),
    );
    yield* forkParked(tick.pipe(Effect.andThen(Effect.sleep("20 seconds")), Effect.forever));
  }),
);
