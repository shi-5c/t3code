import { CodexDesktopError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ServerConfig from "../config.ts";
import { SharedDesktopStore } from "./SharedDesktopStore.ts";

export class DesktopSyncPersistence extends Context.Service<
  DesktopSyncPersistence,
  {
    readonly get: Effect.Effect<SharedDesktopStore, CodexDesktopError>;
  }
>()("t3/codexDesktop/DesktopSyncPersistence") {}

export const layer = Layer.effect(
  DesktopSyncPersistence,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scope = yield* Scope.Scope;
    const failure = (cause: unknown) =>
      new CodexDesktopError({
        message: cause instanceof Error ? cause.message : "Could not open shared Desktop state.",
        outcomeUnknown: false,
      });
    const get = yield* Effect.cached(
      Effect.acquireRelease(
        fs.makeDirectory(config.stateDir, { recursive: true }).pipe(
          Effect.mapError(failure),
          Effect.andThen(
            Effect.try({
              try: () =>
                new SharedDesktopStore(path.join(config.stateDir, "codex-desktop-sync.sqlite")),
              catch: failure,
            }),
          ),
        ),
        (store) => Effect.sync(() => store.close()),
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    return { get };
  }),
);
