import {
  CodexSettings,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { withCodexAppServerClient } from "../provider/CodexProvider.ts";
import { resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import * as ServerSettings from "../serverSettings.ts";

const openRecord = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)]);
const Item = openRecord({
  id: Schema.NonEmptyString,
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
const Turn = openRecord({
  id: Schema.NonEmptyString,
  items: Schema.Array(Item),
  itemsView: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const Thread = openRecord({
  id: Schema.NonEmptyString,
  createdAt: Schema.Number,
  historyMode: Schema.optionalKey(Schema.String),
  turns: Schema.Array(Turn),
});
const decodeThread = Schema.decodeUnknownEffect(Schema.Struct({ thread: Thread }));
const decodePage = Schema.decodeUnknownEffect(
  Schema.Struct({ data: Schema.Array(Turn), nextCursor: Schema.NullOr(Schema.String) }),
);
const decodeItemPage = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Array(openRecord({ turnId: Schema.NonEmptyString, item: Item })),
    nextCursor: Schema.NullOr(Schema.String),
  }),
);
const decodeText = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
);
const decodeSettings = Schema.decodeEffect(CodexSettings);
const decodeThreadList = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Array(Thread),
    nextCursor: Schema.NullOr(Schema.String),
  }),
);

const readCodexDiscoveryPass = Effect.fn("CodexSessionHistory.discoverPages")(function* <E>(
  request: (method: string, params: unknown) => Effect.Effect<unknown, E>,
) {
  const discovered = new Map<string, { thread: typeof Thread.Type; archived: boolean }>();
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const page: {
        readonly data: ReadonlyArray<typeof Thread.Type>;
        readonly nextCursor: string | null;
      } = yield* decodeThreadList(
        yield* request("thread/list", {
          cursor,
          limit: 100,
          sortKey: "created_at",
          sortDirection: "asc",
          modelProviders: [],
          sourceKinds: [],
          archived,
          useStateDbOnly: true,
        }),
      );
      for (const thread of page.data) {
        if (discovered.has(thread.id))
          return yield* new CodexSessionHistoryError({
            nativeThreadId: "discovery",
            cause: "Native discovery overlapped or changed archive membership; retry discovery",
          });
        discovered.set(thread.id, { thread, archived });
      }
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (cursors.has(cursor))
          return yield* new CodexSessionHistoryError({
            nativeThreadId: "discovery",
            cause: "Native discovery pagination did not finish",
          });
        cursors.add(cursor);
      }
    } while (cursor !== null);
  }
  return [...discovered.values()];
});

export const readCodexDiscovery = Effect.fn("CodexSessionHistory.discoverStable")(function* <E>(
  request: (method: string, params: unknown) => Effect.Effect<unknown, E>,
) {
  const first = yield* readCodexDiscoveryPass(request);
  const second = yield* readCodexDiscoveryPass(request);
  const fingerprint = (rows: typeof first) =>
    stableStringify(rows.toSorted((a, b) => a.thread.id.localeCompare(b.thread.id)));
  if (fingerprint(first) !== fingerprint(second))
    return yield* new CodexSessionHistoryError({
      nativeThreadId: "discovery",
      cause: "Native discovery changed between observations; retry discovery",
    });
  return second;
});

export interface CodexHistoryMessage {
  readonly turnId: string;
  readonly itemId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface CodexHistory {
  readonly nativeThreadId: string;
  readonly turnIds?: ReadonlyArray<string>;
  readonly messages: ReadonlyArray<CodexHistoryMessage>;
  readonly omittedItemTypes: ReadonlyArray<string>;
  /** Complete native payloads, including fields and item types unknown to this T3 version. */
  readonly canonical?: {
    readonly thread: typeof Thread.Type;
    readonly turns: ReadonlyArray<typeof Turn.Type>;
    readonly itemEntries: ReadonlyArray<Record<string, unknown>>;
    readonly consistency?: "observed-stable";
  };
}
export interface CodexHistorySource {
  readonly provider: ProviderInstanceConfig;
  readonly homePath: string;
}

export class CodexSessionHistoryError extends Schema.TaggedError<CodexSessionHistoryError>()(
  "CodexSessionHistoryError",
  {
    nativeThreadId: Schema.String,
    cause: Schema.Defect(),
    reason: Schema.optional(Schema.Literal("changed-during-read")),
  },
) {
  override get message() {
    return `Could not read native Codex history for '${this.nativeThreadId}'.`;
  }
}

const isHistoryError = Schema.is(CodexSessionHistoryError);
const decodeTitle = Schema.decodeUnknownEffect(
  Schema.Struct({
    thread: Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
);

export const readCodexTitle = Effect.fn("CodexSessionHistory.readStableTitle")(function* <E>(
  request: (method: string, params: unknown) => Effect.Effect<unknown, E>,
  nativeThreadId: string,
) {
  const read = Effect.gen(function* () {
    const result = yield* decodeTitle(
      yield* request("thread/read", { threadId: nativeThreadId, includeTurns: false }),
    );
    if (result.thread.id !== nativeThreadId)
      return yield* new CodexSessionHistoryError({
        nativeThreadId,
        cause: "Native identity changed",
      });
    return result.thread.name?.trim() ? result.thread.name : null;
  });
  const first = yield* read;
  const second = yield* read;
  if (first !== second)
    return yield* new CodexSessionHistoryError({
      nativeThreadId,
      reason: "changed-during-read",
      cause: "Native title changed while reading",
    });
  return second;
});

// History reads never resume, subscribe to, or acquire the native writer.
const readCodexHistoryOnce = Effect.fn("CodexSessionHistory.readPages")(function* <E>(
  request: (method: string, params: unknown) => Effect.Effect<unknown, E>,
  nativeThreadId: string,
) {
  let { thread } = yield* decodeThread(
    yield* request("thread/read", { threadId: nativeThreadId, includeTurns: false }),
  );
  if (thread.id !== nativeThreadId)
    return yield* new CodexSessionHistoryError({
      nativeThreadId,
      cause: "Native identity changed",
    });
  const turns: Array<typeof Turn.Type> = [];
  const itemEntries: Array<Record<string, unknown>> = [];
  if (thread.historyMode === "paginated") {
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: {
        readonly data: ReadonlyArray<typeof Turn.Type>;
        readonly nextCursor: string | null;
      } = yield* decodePage(
        yield* request("thread/turns/list", {
          threadId: nativeThreadId,
          cursor,
          limit: 100,
          sortDirection: "asc",
          itemsView: "notLoaded",
        }),
      );
      for (const turn of page.data) {
        if (turn.itemsView === "full") {
          turns.push(turn);
          continue;
        }
        const items: Array<typeof Item.Type> = [];
        const itemCursors = new Set<string>();
        let itemCursor: string | null = null;
        do {
          const itemPage: {
            readonly data: ReadonlyArray<
              Record<string, unknown> & { readonly turnId: string; readonly item: typeof Item.Type }
            >;
            readonly nextCursor: string | null;
          } = yield* decodeItemPage(
            yield* request("thread/items/list", {
              threadId: nativeThreadId,
              turnId: turn.id,
              cursor: itemCursor,
              limit: 100,
              sortDirection: "asc",
            }),
          );
          for (const entry of itemPage.data) {
            if (entry.turnId !== turn.id)
              return yield* new CodexSessionHistoryError({
                nativeThreadId,
                cause: "Native item belongs to another turn",
              });
            items.push(entry.item);
            itemEntries.push(entry);
          }
          itemCursor = itemPage.nextCursor;
          if (itemCursor !== null) {
            if (itemCursors.has(itemCursor))
              return yield* new CodexSessionHistoryError({
                nativeThreadId,
                cause: "Native item pagination did not finish",
              });
            itemCursors.add(itemCursor);
          }
        } while (itemCursor !== null);
        turns.push({ ...turn, items, itemsView: "full" });
      }
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (seen.has(cursor))
          return yield* new CodexSessionHistoryError({
            nativeThreadId,
            cause: "Native history pagination did not finish",
          });
        seen.add(cursor);
      }
    } while (cursor !== null);
  } else if (thread.historyMode === "legacy") {
    const complete = yield* decodeThread(
      yield* request("thread/read", { threadId: nativeThreadId, includeTurns: true }),
    );
    if (
      complete.thread.id !== nativeThreadId ||
      complete.thread.historyMode !== "legacy" ||
      complete.thread.turns.some((turn) => turn.itemsView !== "full")
    )
      return yield* new CodexSessionHistoryError({
        nativeThreadId,
        cause: "Native identity, history mode or complete items changed",
      });
    thread = complete.thread;
    turns.push(...complete.thread.turns);
  } else {
    return yield* new CodexSessionHistoryError({
      nativeThreadId,
      cause: "Unsupported native history mode",
    });
  }
  const messages: CodexHistoryMessage[] = [];
  const omitted = new Set<string>();
  const keys = new Set<string>();
  const turnKeys = new Set<string>();
  for (const turn of turns) {
    if (turnKeys.has(turn.id))
      return yield* new CodexSessionHistoryError({
        nativeThreadId,
        cause: "Duplicate native turn identity",
      });
    turnKeys.add(turn.id);
    const startedAt = DateTime.make((turn.startedAt ?? thread.createdAt) * 1_000);
    if (startedAt._tag === "None")
      return yield* new CodexSessionHistoryError({
        nativeThreadId,
        cause: "Invalid native timestamp",
      });
    for (const item of turn.items) {
      const key = `${turn.id.length}:${turn.id}${item.id}`;
      if (keys.has(key))
        return yield* new CodexSessionHistoryError({
          nativeThreadId,
          cause: "Duplicate native item identity",
        });
      keys.add(key);
      let text: string;
      let role: CodexHistoryMessage["role"];
      if (item.type === "agentMessage" && item.text !== undefined) {
        role = "assistant";
        text = item.text;
      } else if (item.type === "userMessage" && item.content !== undefined) {
        role = "user";
        const parts: string[] = [];
        for (const part of item.content) {
          const decoded = decodeText(part);
          if (decoded._tag === "Some") parts.push(decoded.value.text);
          else omitted.add("userMessage attachment");
        }
        text = parts.join("\n");
      } else {
        omitted.add(item.type);
        continue;
      }
      messages.push({
        turnId: turn.id,
        itemId: item.id,
        role,
        text,
        createdAt: DateTime.formatIso(startedAt.value),
      });
    }
  }
  return {
    nativeThreadId,
    turnIds: turns.map((turn) => turn.id),
    messages,
    omittedItemTypes: [...omitted].sort(),
    canonical: { thread, turns, itemEntries },
  } satisfies CodexHistory;
});

/** Two complete observations guard against paging across a rewind or producer mutation.
 * This is an observed stable read, not a transaction spanning the native writer. */
export const readCodexHistory = Effect.fn("CodexSessionHistory.readStableHistory")(function* <E>(
  request: (method: string, params: unknown) => Effect.Effect<unknown, E>,
  nativeThreadId: string,
) {
  const first = yield* readCodexHistoryOnce(request, nativeThreadId);
  const second = yield* readCodexHistoryOnce(request, nativeThreadId);
  if (stableStringify(first.canonical) !== stableStringify(second.canonical))
    return yield* new CodexSessionHistoryError({
      nativeThreadId,
      reason: "changed-during-read",
      cause:
        "Native history changed while reading. The previous cache is preserved; retry after it settles.",
    });
  return { ...second, canonical: { ...second.canonical, consistency: "observed-stable" as const } };
});

export class CodexSessionHistory extends Context.Service<
  CodexSessionHistory,
  {
    readonly discover?: (
      providerInstanceId: ProviderInstanceId,
      source?: CodexHistorySource,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly thread: typeof Thread.Type; readonly archived: boolean }>,
      CodexSessionHistoryError
    >;
    readonly read: (input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly nativeThreadId: string;
      readonly cwd: string;
      readonly source?: CodexHistorySource;
    }) => Effect.Effect<CodexHistory, CodexSessionHistoryError>;
    readonly readTitle?: (input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly nativeThreadId: string;
      readonly source: CodexHistorySource;
    }) => Effect.Effect<string | null, CodexSessionHistoryError>;
  }
>()("t3/project/CodexSessionHistory") {}

export const layer = Layer.effect(
  CodexSessionHistory,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const environment = yield* HostProcess.Environment;
    const fs = yield* FileSystem.FileSystem;
    const openReader = Effect.fn("CodexSessionHistory.openReader")(function* (input: {
      providerInstanceId: ProviderInstanceId;
      nativeThreadId: string;
      cwd?: string;
      source?: CodexHistorySource;
    }) {
      const instance = (yield* settings.getSettings).providerInstances[input.providerInstanceId];
      if (!instance || instance.driver !== "codex" || !resolveProviderInstanceEnabled(instance))
        return yield* new CodexSessionHistoryError({
          nativeThreadId: input.nativeThreadId,
          cause: "Codex provider is unavailable",
        });
      if (input.source && stableStringify(instance) !== stableStringify(input.source.provider))
        return yield* new CodexSessionHistoryError({
          nativeThreadId: input.nativeThreadId,
          cause: "The verified provider configuration changed",
        });
      const config = yield* decodeSettings(instance.config ?? {});
      const env = yield* mergeProviderInstanceEnvironment(instance.environment, environment);
      const layout = yield* resolveCodexHomeLayout(
        !config.homePath.trim() && !config.shadowHomePath.trim() && env.CODEX_HOME?.trim()
          ? { ...config, homePath: env.CODEX_HOME }
          : config,
      ).pipe(Effect.provideService(Path.Path, path));
      if (
        input.source &&
        normalizeProjectPathForComparison(
          yield* fs.realPath(layout.effectiveHomePath ?? layout.sharedHomePath),
        ) !== input.source.homePath
      )
        return yield* new CodexSessionHistoryError({
          nativeThreadId: input.nativeThreadId,
          cause: "The verified native history source changed",
        });
      const { client } = yield* withCodexAppServerClient({
        binaryPath: expandHomePath(config.binaryPath, home),
        homePath: input.source?.homePath ?? layout.effectiveHomePath ?? layout.sharedHomePath,
        launchArgs: resolveCodexLaunchArgs(config.launchArgs, env),
        cwd: input.cwd ?? layout.effectiveHomePath ?? layout.sharedHomePath ?? home,
        environment: env,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      return client;
    });
    return CodexSessionHistory.of({
      readTitle: Effect.fn("CodexSessionHistory.readTitle")(
        function* (input) {
          const client = yield* openReader({ ...input, cwd: input.source.homePath });
          return yield* readCodexTitle(client.raw.request, input.nativeThreadId);
        },
        Effect.scoped,
        Effect.timeout("10 seconds"),
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isHistoryError(cause)
                ? cause
                : new CodexSessionHistoryError({ nativeThreadId: input.nativeThreadId, cause }),
            ),
          ),
      ),
      discover: Effect.fn("CodexSessionHistory.discover")(
        (providerInstanceId: ProviderInstanceId, source?: CodexHistorySource) =>
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* openReader({
                providerInstanceId,
                nativeThreadId: "discovery",
                ...(source ? { source } : {}),
              });
              return yield* readCodexDiscovery(client.raw.request);
            }),
          ).pipe(
            Effect.timeout("60 seconds"),
            Effect.mapError(
              (cause) => new CodexSessionHistoryError({ nativeThreadId: "discovery", cause }),
            ),
          ),
      ),
      read: Effect.fn("CodexSessionHistory.read")(
        function* (input) {
          const client = yield* openReader(input);
          return yield* readCodexHistory(client.raw.request, input.nativeThreadId);
        },
        Effect.scoped,
        Effect.timeout("120 seconds"),
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isHistoryError(cause)
                ? cause
                : new CodexSessionHistoryError({ nativeThreadId: input.nativeThreadId, cause }),
            ),
          ),
      ),
    });
  }),
);
