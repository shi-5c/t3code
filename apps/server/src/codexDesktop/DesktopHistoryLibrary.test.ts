import * as Context from "effect/Context";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Contracts from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { ServerConfig } from "../config.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";
import {
  CodexSessionHistory,
  CodexSessionHistoryError,
  type CodexHistory,
} from "../project/CodexSessionHistory.ts";
import * as Library from "./DesktopHistoryLibrary.ts";

const layer = ServerConfig.layerTest("/workspace", { prefix: "t3-library-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
it.effect(
  "bounds unstable reads while admitting untried long histories and retaining ordinary backoff",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = path.join(config.stateDir, "retry-source");
      yield* fs.makeDirectory(home, { recursive: true });
      const ids = Array.from({ length: 12 }, (_, n) => `id-${String(n).padStart(2, "0")}`);
      const calls: string[] = [];
      const firstRead = yield* Deferred.make<void>();
      const completeRead = yield* Deferred.make<void>();
      let settled = false;
      const library = Context.get(
        yield* Layer.build(
          Library.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(CodexSessionHistory, {
                  discover: () =>
                    Effect.succeed(
                      ids.map((id) => ({
                        thread: { id, createdAt: 1, turns: [] },
                        archived: false,
                      })),
                    ),
                  read: ({ nativeThreadId: id }) =>
                    Effect.gen(function* () {
                      calls.push(id);
                      if (calls.length === 1) {
                        yield* Deferred.succeed(firstRead, undefined);
                        yield* Deferred.await(completeRead);
                      }
                      if (id === "id-01" || (id === "id-00" && !settled))
                        return yield* new CodexSessionHistoryError({
                          nativeThreadId: id,
                          cause:
                            "Native history changed while reading. The previous cache is preserved; retry after it settles.",
                          ...(id === "id-00" ? { reason: "changed-during-read" as const } : {}),
                        });
                      const items = Array.from({ length: id === "id-11" ? 1_500 : 1 }, (_, n) => ({
                        id: `item-${n}`,
                        type: "agentMessage",
                        text: `body-${n}`,
                      }));
                      return {
                        nativeThreadId: id,
                        turnIds: ["turn"],
                        messages: [],
                        omittedItemTypes: [],
                        canonical: {
                          consistency: "observed-stable" as const,
                          thread: { id, createdAt: 1, turns: [] },
                          turns: [{ id: "turn", items }],
                          itemEntries: [],
                        },
                      };
                    }),
                }),
                Settings.layerTest({
                  providerInstances: {
                    [Contracts.ProviderInstanceId.make("codex-desktop")]: {
                      driver: "codex",
                      enabled: true,
                      config: { setupMode: "existing", homePath: home },
                    },
                  },
                }),
                Layer.succeed(HostProcess.Environment, { CODEX_HOME: home }),
                Layer.succeed(ServerActivation, Effect.never),
              ),
            ),
          ),
        ),
        Library.DesktopHistoryLibrary,
      );
      const initial = yield* library.refresh.pipe(Effect.forkScoped);
      yield* Deferred.await(firstRead);
      yield* TestClock.adjust("90 seconds");
      yield* Deferred.succeed(completeRead, undefined);
      yield* Fiber.join(initial);
      assert.equal(calls.length, 10);
      yield* library.refresh;
      assert.deepEqual(calls.slice(10), ["id-10", "id-11"]);
      yield* TestClock.adjust("15 seconds");
      yield* library.refresh;
      assert.deepEqual(calls.slice(10), ["id-10", "id-11", "id-00"]);
      assert.equal((yield* library.read("id-11"))?.canonical?.turns[0]?.items.length, 1_500);
      yield* TestClock.adjust("15 seconds");
      yield* library.refresh;
      assert.equal(calls.length, 13);
      yield* TestClock.adjust("15 seconds");
      yield* library.refresh;
      assert.equal(calls.filter((id) => id === "id-00").length, 3);
      yield* TestClock.adjust("15 seconds");
      yield* library.refresh;
      assert.equal(calls.filter((id) => id === "id-00").length, 3);
      assert.equal(calls.filter((id) => id === "id-01").length, 1);
      settled = true;
      yield* TestClock.adjust("285 seconds");
      yield* library.refresh;
      assert.equal(calls.filter((id) => id === "id-00").length, 3);
      yield* library.refresh;
      assert.equal(calls.filter((id) => id === "id-00").length, 4);
      assert.equal(calls.filter((id) => id === "id-01").length, 2);
      assert.equal(
        (yield* library.state).entries.find((entry) => entry.conversationId === "id-00")?.status,
        "cached",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
it.effect("publishes an acquired store even if its first caller is cancelled during opening", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let acquisitions = 0;
    const library = Context.get(
      yield* Layer.build(
        Library.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(CodexSessionHistory)({ discover: () => Effect.succeed([]) }),
              Settings.layerTest(),
              Layer.succeed(HostProcess.Environment, { CODEX_HOME: config.stateDir }),
              Layer.succeed(ServerActivation, Effect.never),
              Layer.succeed(FileSystem.FileSystem, {
                ...fs,
                makeDirectory: (directory, options) =>
                  Effect.gen(function* () {
                    if (directory === config.stateDir && ++acquisitions === 1) {
                      yield* Deferred.succeed(entered, undefined);
                      yield* Deferred.await(release);
                    }
                    yield* fs.makeDirectory(directory, options);
                  }),
              }),
            ),
          ),
        ),
      ),
      Library.DesktopHistoryLibrary,
    );
    const first = yield* library.state.pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Effect.sync(() => first.interruptUnsafe());
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.await(first);
    yield* library.state;
    assert.equal(acquisitions, 1);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
it.effect("recovers a failed cache acquisition and opens one store for concurrent callers", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = path.join(config.stateDir, "native-source");
    yield* fs.makeDirectory(home, { recursive: true });
    const blocked = path.join(config.stateDir, "blocked-cache");
    yield* fs.writeFileString(blocked, "temporary obstruction");
    let acquisitions = 0;
    const library = Context.get(
      yield* Layer.build(
        Library.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(CodexSessionHistory)({ discover: () => Effect.succeed([]) }),
              Settings.layerTest(),
              Layer.succeed(HostProcess.Environment, { CODEX_HOME: home }),
              Layer.succeed(ServerActivation, Effect.never),
              Layer.succeed(ServerConfig, { ...config, stateDir: blocked }),
              Layer.succeed(FileSystem.FileSystem, {
                ...fs,
                makeDirectory: (directory, options) =>
                  Effect.suspend(() => {
                    if (directory === blocked) acquisitions++;
                    return fs.makeDirectory(directory, options);
                  }),
              }),
            ),
          ),
        ),
      ),
      Library.DesktopHistoryLibrary,
    );
    yield* library.state.pipe(Effect.flip);
    assert.equal(acquisitions, 1);
    yield* fs.remove(blocked);
    const states = yield* Effect.all([library.state, library.state], { concurrency: "unbounded" });
    assert.deepEqual(states[0]?.entries, []);
    yield* library.state;
    assert.equal(acquisitions, 2);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
it.effect.each(["disabled", "changed", "changed during discovery"])(
  "retains the last complete snapshot if Share is %s during a pinned read",
  (problem) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = path.join(config.stateDir, "native-source");
      yield* fs.makeDirectory(home, { recursive: true });
      const instanceId = Contracts.ProviderInstanceId.make("codex-desktop");
      const settings = yield* Settings.ServerSettingsService.pipe(
        Effect.provide(
          Settings.layerTest({
            providerInstances: {
              [instanceId]: {
                driver: "codex",
                enabled: true,
                config: { setupMode: "existing", homePath: home },
              },
            },
          }),
        ),
      );
      const verifiedHome = normalizeProjectPathForComparison(yield* fs.realPath(home));
      const changes = yield* PubSub.unbounded<Contracts.ServerSettings>();
      const interrupted = yield* Deferred.make<void>();
      let beforeRead: Effect.Effect<void, Contracts.ServerSettingsError> = Effect.void;
      let beforeDiscovery: Effect.Effect<void, Contracts.ServerSettingsError> = Effect.void;
      let reads = 0;
      const value: CodexHistory = {
        nativeThreadId: "old",
        turnIds: [],
        messages: [],
        omittedItemTypes: [],
        canonical: {
          consistency: "observed-stable",
          thread: { id: "old", createdAt: 1, turns: [] },
          turns: [],
          itemEntries: [],
        },
      };
      const history = Layer.succeed(CodexSessionHistory, {
        discover: (_id, source) =>
          Effect.sync(() => {
            assert.equal(source?.homePath, verifiedHome);
            return [
              {
                thread: { id: "old", createdAt: 1, turns: [], cwd: "/missing-workspace" },
                archived: false,
              },
            ];
          }).pipe(
            Effect.tap(() => beforeDiscovery),
            Effect.orDie,
          ),
        read: (input) =>
          Effect.gen(function* () {
            assert.equal(input.source?.homePath, verifiedHome);
            assert.equal(input.cwd, verifiedHome);
            reads++;
            yield* beforeRead;
            return value;
          }).pipe(Effect.orDie),
      });
      const library = Context.get(
        yield* Layer.build(
          Library.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                history,
                Layer.succeed(Settings.ServerSettingsService, {
                  ...settings,
                  subscribeChanges: PubSub.subscribe(changes).pipe(
                    Effect.map(Stream.fromSubscription),
                  ),
                }),
                Layer.succeed(HostProcess.Environment, { CODEX_HOME: home }),
                Layer.succeed(ServerActivation, Effect.never),
              ),
            ),
          ),
        ),
        Library.DesktopHistoryLibrary,
      );
      yield* library.refresh;
      const before = yield* library.state;
      assert.equal(before.entries.length, 1);
      assert.equal(before.entries[0]?.status, "cached");
      assert.equal(before.cache?.sourceVersions, 1);
      const previous = (yield* settings.getSettings).providerInstances[instanceId]!;
      const invalidated = settings
        .updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            ...previous,
            ...(problem === "disabled"
              ? { enabled: false }
              : { config: { setupMode: "existing", homePath: path.join(home, "different") } }),
          },
        })
        .pipe(
          Effect.andThen(settings.getSettings),
          Effect.flatMap((next) => PubSub.publish(changes, next)),
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(interrupted, undefined)),
        );
      yield* TestClock.adjust("5 minutes");
      if (problem === "changed during discovery") beforeDiscovery = invalidated;
      else beforeRead = invalidated;
      yield* library.refresh;
      yield* Deferred.await(interrupted);
      assert.equal(reads, problem === "changed during discovery" ? 1 : 2);
      assert.deepEqual((yield* library.state).entries, before.entries);
      assert.deepEqual(yield* library.read("old", before.entries[0]!.sourceId), value);
      assert.isFalse(yield* library.mayProject(before.entries[0]!.sourceId));
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
