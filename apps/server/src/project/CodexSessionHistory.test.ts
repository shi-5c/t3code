import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { readCodexHistory } from "./CodexSessionHistory.ts";
import { readCodexDiscovery } from "./CodexSessionHistory.ts";
import * as CodexSessionHistory from "./CodexSessionHistory.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ProviderInstanceId } from "@t3tools/contracts";

it.effect.each(["stable", "blank", "changed", "wrong-id"] as const)(
  "reads only explicit metadata with stable identity (%s)",
  (condition) =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const result = yield* Effect.result(
        CodexSessionHistory.readCodexTitle(
          (method, params) =>
            Effect.sync(() => {
              calls.push([method, params]);
              return {
                thread: {
                  id: condition === "wrong-id" ? "other" : "native",
                  name:
                    condition === "blank"
                      ? " "
                      : condition === "changed" && calls.length === 2
                        ? "B"
                        : "A",
                },
              };
            }),
          "native",
        ),
      );
      expect(calls).toEqual(
        Array.from({ length: condition === "wrong-id" ? 1 : 2 }, () => [
          "thread/read",
          { threadId: "native", includeTurns: false },
        ]),
      );
      if (condition === "stable" || condition === "blank")
        expect(result).toMatchObject({ success: condition === "stable" ? "A" : null });
      else expect(result._tag).toBe("Failure");
    }),
);

it.effect(
  "reads every native page without acquiring the writer or trusting reader lifecycle status",
  () =>
    Effect.gen(function* () {
      const methods: string[] = [];
      const result = yield* readCodexHistory(
        (method, params) =>
          Effect.sync(() => {
            methods.push(method);
            if (method === "thread/read")
              return {
                thread: {
                  id: "native",
                  createdAt: 1,
                  historyMode: "paginated",
                  status: { type: "notLoaded" },
                  turns: [],
                },
              };
            const cursor = (params as { cursor: string | null }).cursor;
            return cursor === null
              ? {
                  data: [
                    {
                      id: "turn-1",
                      status: "interrupted",
                      itemsView: "full",
                      items: [
                        {
                          id: "user-1",
                          type: "userMessage",
                          content: [{ type: "text", text: "Repeat" }],
                        },
                      ],
                    },
                  ],
                  nextCursor: "next",
                }
              : {
                  data: [
                    {
                      id: "turn-2",
                      status: "completed",
                      itemsView: "full",
                      items: [
                        {
                          id: "user-2",
                          type: "userMessage",
                          content: [
                            { type: "text", text: "Repeat" },
                            { type: "image", url: "image" },
                          ],
                        },
                        { id: "agent-2", type: "agentMessage", text: "Answer" },
                        { id: "tool", type: "commandExecution" },
                      ],
                    },
                    {
                      id: "tool-only",
                      itemsView: "full",
                      items: [{ id: "other-tool", type: "commandExecution" }],
                    },
                  ],
                  nextCursor: null,
                };
          }),
        "native",
      );
      expect(methods).toEqual(
        Array.from({ length: 2 }, () => [
          "thread/read",
          "thread/turns/list",
          "thread/turns/list",
        ]).flat(),
      );
      expect(result.messages.map(({ turnId, itemId, text }) => ({ turnId, itemId, text }))).toEqual(
        [
          { turnId: "turn-1", itemId: "user-1", text: "Repeat" },
          { turnId: "turn-2", itemId: "user-2", text: "Repeat" },
          { turnId: "turn-2", itemId: "agent-2", text: "Answer" },
        ],
      );
      expect(result.omittedItemTypes).toEqual(["commandExecution", "userMessage attachment"]);
      expect(result.turnIds).toEqual(["turn-1", "turn-2", "tool-only"]);
      expect(result.canonical?.thread.status).toEqual({ type: "notLoaded" });
      expect(result.canonical?.turns[1]?.items[0]?.content?.[1]).toEqual({
        type: "image",
        url: "image",
      });
    }),
);

it.effect("reads paginated item bodies and retains future fields without a rollout file", () =>
  Effect.gen(function* () {
    const methods: string[] = [];
    const history = yield* readCodexHistory(
      (method, params) =>
        Effect.sync(() => {
          methods.push(method);
          if (method === "thread/read")
            return {
              thread: {
                id: "compressed",
                createdAt: 1,
                historyMode: "paginated",
                turns: [],
                path: "missing.jsonl",
                forkedFromId: "parent",
              },
            };
          if (method === "thread/turns/list")
            return {
              data: [
                {
                  id: "inherited-turn",
                  items: [],
                  itemsView: "summary",
                  producerField: "preserved",
                },
              ],
              nextCursor: null,
            };
          const cursor = (params as { cursor: string | null }).cursor;
          return cursor === null
            ? {
                data: [
                  {
                    turnId: "inherited-turn",
                    startedAtMs: 123,
                    item: { id: "future", type: "futureTool", payload: { nested: ["complete"] } },
                  },
                ],
                nextCursor: "item-next",
              }
            : {
                data: [
                  {
                    turnId: "inherited-turn",
                    item: { id: "agent", type: "agentMessage", text: "complete" },
                  },
                ],
                nextCursor: null,
              };
        }),
      "compressed",
    );
    expect(methods).toEqual(
      Array.from({ length: 2 }, () => [
        "thread/read",
        "thread/turns/list",
        "thread/items/list",
        "thread/items/list",
      ]).flat(),
    );
    expect(history.canonical?.thread.forkedFromId).toBe("parent");
    expect(history.canonical?.turns[0]?.producerField).toBe("preserved");
    expect(history.canonical?.turns[0]?.items[0]?.payload).toEqual({ nested: ["complete"] });
    expect(history.canonical?.itemEntries[0]?.startedAtMs).toBe(123);
    expect(history.messages[0]?.text).toBe("complete");
  }),
);

it.effect("rejects missing instance identity before starting a default-home reader", () =>
  Effect.gen(function* () {
    let spawned = false;
    const reader = yield* CodexSessionHistory.CodexSessionHistory.pipe(
      Effect.provide(
        CodexSessionHistory.layer.pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
              spawn: () =>
                Effect.sync(() => {
                  spawned = true;
                }).pipe(Effect.andThen(Effect.die("Unexpected spawn"))),
            }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    const result = yield* reader
      .read({
        providerInstanceId: ProviderInstanceId.make("missing-native-instance"),
        nativeThreadId: "native",
        cwd: "/workspace",
      })
      .pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    expect(spawned).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect.each(["summary", "repeated cursor", "duplicate identity"])(
  "rejects %s without returning a partial snapshot",
  (failure) =>
    Effect.gen(function* () {
      const result = yield* readCodexHistory(
        (method) =>
          Effect.succeed(
            method === "thread/read"
              ? { thread: { id: "native", createdAt: 1, historyMode: "paginated", turns: [] } }
              : {
                  data: [
                    {
                      id: "turn",
                      itemsView: failure === "summary" ? "summary" : "full",
                      items:
                        failure === "duplicate identity"
                          ? [
                              { id: "same", type: "agentMessage", text: "a" },
                              { id: "same", type: "agentMessage", text: "b" },
                            ]
                          : [],
                    },
                  ],
                  nextCursor: failure === "repeated cursor" ? "same" : null,
                },
          ),
        "native",
      ).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
    }),
);

it.effect.each([
  "unknown mode",
  "mode changed",
  "legacy summary",
  "rewind",
  "missing cursor",
  "wrong turn",
  "repeated item cursor",
])("refuses a complete cache snapshot for %s", (problem) =>
  Effect.gen(function* () {
    let reads = 0;
    const result = yield* readCodexHistory(
      (method, params) =>
        Effect.sync(() => {
          if (method === "thread/read") {
            reads++;
            const mode =
              problem === "unknown mode"
                ? "future"
                : problem === "mode changed"
                  ? reads === 1
                    ? "legacy"
                    : "paginated"
                  : problem === "legacy summary"
                    ? "legacy"
                    : "paginated";
            return {
              thread: {
                id: "native",
                createdAt: 1,
                historyMode: mode,
                turns:
                  mode === "legacy" && (params as { includeTurns: boolean }).includeTurns
                    ? [{ id: "turn", itemsView: "summary", items: [] }]
                    : [],
              },
            };
          }
          if (method === "thread/items/list")
            return {
              data: [
                {
                  turnId: problem === "wrong turn" ? "other" : "turn",
                  item: { id: "item", type: "agentMessage", text: "body" },
                },
              ],
              nextCursor: "repeat",
            };
          return {
            data: [
              {
                id: "turn",
                itemsView: ["wrong turn", "repeated item cursor"].includes(problem)
                  ? "summary"
                  : "full",
                items: [
                  {
                    id: "item",
                    type: "agentMessage",
                    text: problem === "rewind" && reads > 1 ? "rewritten" : "original",
                  },
                ],
              },
            ],
            ...(problem === "missing cursor" ? {} : { nextCursor: null }),
          };
        }),
      "native",
    ).pipe(Effect.flip);
    expect("reason" in result ? result.reason : undefined).toBe(
      problem === "rewind" ? "changed-during-read" : undefined,
    );
  }),
);

it.effect(
  "discovers active and archived history across all providers without repair or a time cutoff",
  () =>
    Effect.gen(function* () {
      const parameters: Array<Record<string, unknown>> = [];
      const expected = Array.from({ length: 205 }, (_, index) => `native-${index}`);
      const rows = yield* readCodexDiscovery((method, params) =>
        Effect.sync(() => {
          expect(method).toBe("thread/list");
          const input = params as Record<string, unknown>;
          parameters.push(input);
          return {
            data: (input.archived
              ? expected.slice(200)
              : input.cursor
                ? expected.slice(100, 200)
                : expected.slice(0, 100)
            ).map((id) => ({
              id,
              createdAt: 1,
              historyMode: "paginated",
              turns: [],
            })),
            nextCursor: !input.archived && !input.cursor ? "second" : null,
          };
        }),
      );
      expect(new Set(rows.map((row) => row.thread.id))).toEqual(new Set(expected));
      expect(parameters).toHaveLength(6);
      for (const input of parameters)
        expect(input).toMatchObject({
          modelProviders: [],
          useStateDbOnly: true,
          sourceKinds: [],
          sortKey: "created_at",
        });
    }),
);

it.effect.each(["overlap", "archive race", "changing list"])(
  "rejects unstable native discovery instead of claiming completeness: %s",
  (problem) =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* Effect.exit(
        readCodexDiscovery((_method, params) =>
          Effect.sync(() => {
            const input = params as { archived: boolean; cursor: string | null };
            calls += 1;
            return {
              data:
                input.archived && problem !== "archive race"
                  ? []
                  : [
                      {
                        id: problem === "changing list" && calls > 2 ? "changed" : "same",
                        createdAt: 1,
                        turns: [],
                      },
                    ],
              nextCursor:
                problem === "overlap" && !input.archived && !input.cursor ? "overlap" : null,
            };
          }),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
);

it.effect.each([
  "configuration changed",
  "physical source changed",
  "timeout",
  "metadata configuration changed",
  "metadata physical source changed",
  "metadata timeout",
])("pins the real reader source and stops safely on %s", (problem) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const physicalHome = normalizeProjectPathForComparison(yield* fs.realPath(home));
    const instanceId = ProviderInstanceId.make("codex-desktop");
    const settings = yield* ServerSettings.ServerSettingsService.pipe(
      Effect.provide(
        ServerSettings.layerTest({
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
    const provider = (yield* settings.getSettings).providerInstances[instanceId]!;
    const started = yield* Deferred.make<void>();
    let spawned = false;
    const reader = yield* CodexSessionHistory.CodexSessionHistory.pipe(
      Effect.provide(
        CodexSessionHistory.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ServerSettings.ServerSettingsService, settings),
              Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
                spawn: () =>
                  Effect.sync(() => {
                    spawned = true;
                  }).pipe(
                    Effect.andThen(Deferred.succeed(started, undefined)),
                    Effect.andThen(Effect.never),
                  ),
              }),
            ),
          ),
        ),
      ),
    );
    const input = {
      providerInstanceId: instanceId,
      nativeThreadId: "native",
      cwd: home,
      source: {
        provider: problem.endsWith("configuration changed")
          ? { ...provider, displayName: "Old config" }
          : provider,
        homePath: problem.endsWith("physical source changed")
          ? "previous-physical-source"
          : physicalHome,
      },
    };
    const pending = yield* (
      problem.startsWith("metadata")
        ? reader.readTitle!(input).pipe(Effect.asVoid)
        : reader.read(input).pipe(Effect.asVoid)
    ).pipe(Effect.exit, Effect.forkScoped);
    if (problem.endsWith("timeout")) {
      yield* Deferred.await(started);
      yield* TestClock.adjust(problem.startsWith("metadata") ? "11 seconds" : "121 seconds");
    }
    expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
    expect(spawned).toBe(problem.endsWith("timeout"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
