import * as NodeSqlite from "node:sqlite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CodexDesktopError,
  type CodexDesktopList,
  type CodexDesktopListInput,
  type CodexDesktopPreview,
  type CodexDesktopSend,
  type CodexDesktopState,
  type CodexDesktopStop,
  type CodexDesktopUpdate,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { DesktopMirror } from "./DesktopMirror.ts";
import { readDesktopConversationPage } from "./DesktopConversationCatalog.ts";
import { readDesktopHistoryPreview } from "./DesktopHistoryPreview.ts";
import { DesktopTransportError } from "./protocol.ts";
import { desktopWireUpdate } from "./wire.ts";
import type { DesktopRequestRef } from "./requests.ts";

const failure = (error: unknown) =>
  new CodexDesktopError({
    message: error instanceof Error ? error.message : "Codex Desktop is unavailable.",
    outcomeUnknown: error instanceof DesktopTransportError && error.outcomeUnknown,
  });

export interface DesktopCanonicalSnapshot {
  readonly view: CodexDesktopState;
  readonly state: Record<string, unknown> | null;
}

export class CodexDesktop extends Context.Service<
  CodexDesktop,
  {
    readonly list: (
      input?: CodexDesktopListInput,
    ) => Effect.Effect<CodexDesktopList, CodexDesktopError>;
    readonly preview: (id: string) => Effect.Effect<CodexDesktopPreview, CodexDesktopError>;
    readonly home: Effect.Effect<string>;
    readonly watch: (id: string) => Stream.Stream<CodexDesktopUpdate, CodexDesktopError>;
    readonly watchCanonical: (
      id: string,
    ) => Stream.Stream<DesktopCanonicalSnapshot, CodexDesktopError>;
    readonly start: (
      id: string,
      request: Record<string, unknown>,
    ) => Effect.Effect<{ nativeTurnId: string }, CodexDesktopError>;
    readonly waitUntilIdle: (id: string) => Effect.Effect<void, CodexDesktopError>;
    readonly respond: (
      id: string,
      ref: DesktopRequestRef,
      payload: Record<string, unknown>,
    ) => Effect.Effect<void, CodexDesktopError>;
    readonly send: (
      input: CodexDesktopSend,
    ) => Effect.Effect<{ clientMessageId: string }, CodexDesktopError>;
    readonly stop: (input: CodexDesktopStop) => Effect.Effect<void, CodexDesktopError>;
  }
>()("t3/codexDesktop/CodexDesktop") {}

export const layer = Layer.effect(
  CodexDesktop,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const environment = yield* HostProcess.Environment;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const mirrors = new Map<string, DesktopMirror>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const mirror of mirrors.values()) mirror.close();
        mirrors.clear();
      }),
    );
    const list = Effect.fn("CodexDesktop.list")(function* (
      input: CodexDesktopListInput = {},
    ): Effect.fn.Return<CodexDesktopList, CodexDesktopError> {
      if (platform !== "win32")
        return {
          supported: false,
          detail: "Shared Codex Desktop conversations currently require a Windows host.",
          conversations: [],
        };
      const home = environment.CODEX_HOME || path.join(homeDirectory, ".codex");
      const files = yield* fileSystem.readDirectory(home).pipe(Effect.mapError(failure));
      const file = files
        .filter((name) => /^state_\d+\.sqlite$/.test(name))
        .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))[0];
      if (!file)
        return {
          supported: true,
          detail: "No Codex conversations found. Open a conversation in Codex Desktop.",
          conversations: [],
        };
      return yield* Effect.try({
        try: (): CodexDesktopList => {
          const db = new NodeSqlite.DatabaseSync(path.join(home, file), { readOnly: true });
          try {
            return readDesktopConversationPage(db, input);
          } finally {
            db.close();
          }
        },
        catch: failure,
      });
    });
    const requireMirror = (id: string) =>
      Effect.try({
        try: () => {
          const mirror = mirrors.get(id);
          if (!mirror) throw new Error("Connect to this conversation before sending.");
          return mirror;
        },
        catch: failure,
      });
    const watchCanonical = (id: string) =>
      Stream.callback<DesktopCanonicalSnapshot, CodexDesktopError>(
        (queue) =>
          Effect.acquireRelease(
            Effect.try({
              try: () => {
                if (platform !== "win32")
                  throw new Error("Codex Desktop sharing requires a Windows host.");
                let mirror = mirrors.get(id);
                const fresh = !mirror;
                if (!mirror) {
                  if (mirrors.size >= 32)
                    throw new Error("Too many followed Codex Desktop conversations.");
                  mirror = new DesktopMirror(id);
                  mirrors.set(id, mirror);
                }
                const followedMirror = mirror;
                const emit = (state: CodexDesktopState) => {
                  Queue.offerUnsafe(queue, { view: state, state: followedMirror.canonicalState });
                };
                mirror.listeners.add(emit);
                emit(mirror.view);
                if (fresh) void mirror.connect();
                return { mirror, emit };
              },
              catch: failure,
            }),
            ({ mirror, emit }) =>
              Effect.sync(() => {
                mirror.listeners.delete(emit);
                if (!mirror.listeners.size) {
                  mirror.close();
                  mirrors.delete(id);
                }
              }),
          ),
        { bufferSize: 1, strategy: "sliding" },
      );
    return {
      list,
      preview: Effect.fn("CodexDesktop.preview")(function* (id: string) {
        if (platform !== "win32")
          return yield* failure(new Error("This host does not support Codex Desktop history."));
        const home = environment.CODEX_HOME || path.join(homeDirectory, ".codex");
        const files = yield* fileSystem.readDirectory(home).pipe(Effect.mapError(failure));
        const file = files
          .filter((name) => /^state_\d+\.sqlite$/.test(name))
          .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))[0];
        if (!file) return yield* failure(new Error("No Codex history database was found."));
        return yield* Effect.try({
          try: () => {
            const db = new NodeSqlite.DatabaseSync(path.join(home, file), { readOnly: true });
            try {
              return readDesktopHistoryPreview(db, home, id);
            } finally {
              db.close();
            }
          },
          catch: failure,
        });
      }),
      home: Effect.succeed(environment.CODEX_HOME || path.join(homeDirectory, ".codex")),
      watchCanonical,
      waitUntilIdle: Effect.fn("CodexDesktop.waitUntilIdle")((id: string) =>
        watchCanonical(id).pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.view.status === "ready" &&
              snapshot.view.activeTurnId === null &&
              snapshot.view.pendingRequests === 0,
          ),
          Stream.take(1),
          Stream.runDrain,
        ),
      ),
      start: Effect.fn("CodexDesktop.start")(function* (
        id: string,
        request: Record<string, unknown>,
      ) {
        const mirror = yield* requireMirror(id);
        return yield* Effect.tryPromise({ try: () => mirror.start(request), catch: failure });
      }),
      respond: Effect.fn("CodexDesktop.respond")(function* (
        id: string,
        ref: DesktopRequestRef,
        payload: Record<string, unknown>,
      ) {
        const mirror = yield* requireMirror(id);
        yield* Effect.tryPromise({ try: () => mirror.respond(ref, payload), catch: failure });
      }),
      watch: (id) =>
        watchCanonical(id).pipe(
          Stream.map((snapshot) => snapshot.view),
          Stream.mapAccum(
            () => null as CodexDesktopState | null,
            (previous, next) => [next, [desktopWireUpdate(previous, next)]] as const,
          ),
        ),
      send: Effect.fn("CodexDesktop.send")(function* (input: CodexDesktopSend) {
        const mirror = yield* requireMirror(input.conversationId);
        return yield* Effect.tryPromise({ try: () => mirror.send(input), catch: failure });
      }),
      stop: Effect.fn("CodexDesktop.stop")(function* (input: CodexDesktopStop) {
        const mirror = yield* requireMirror(input.conversationId);
        yield* Effect.tryPromise({ try: () => mirror.stop(input.expectedTurnId), catch: failure });
      }),
    };
  }),
);
