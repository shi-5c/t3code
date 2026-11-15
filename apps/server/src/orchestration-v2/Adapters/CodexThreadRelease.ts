import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class CodexThreadReleaseError extends Schema.TaggedError<CodexThreadReleaseError>()(
  "CodexThreadReleaseError",
  { message: Schema.String },
) {}

/** One instance per app-server process. Close notifications have no request ID. */
export function makeCodexThreadRelease<E>(terminated: Effect.Effect<unknown, E>) {
  const waiting = new Map<string, Deferred.Deferred<void>>();
  return {
    closed: (nativeId: string) =>
      Effect.suspend(() => {
        const signal = waiting.get(nativeId);
        return signal ? Deferred.succeed(signal, undefined).pipe(Effect.asVoid) : Effect.void;
      }),
    confirm: Effect.fn("CodexThreadRelease.confirm")(function* <E2, E3>(
      nativeId: string,
      unsubscribe: Effect.Effect<unknown, E2>,
      isLoaded: Effect.Effect<boolean, E3>,
    ) {
      if (waiting.has(nativeId))
        return yield* new CodexThreadReleaseError({
          message: "A native release is already pending.",
        });
      const signal = yield* Deferred.make<void>();
      waiting.set(nativeId, signal);
      return yield* Effect.gen(function* () {
        // Install before the request: thread/closed may arrive before its response.
        yield* unsubscribe;
        yield* Deferred.await(signal);
        // A late duplicate close from a previous generation must not release a loaded writer.
        if (yield* isLoaded)
          return yield* new CodexThreadReleaseError({
            message: "Codex still lists this native thread as loaded.",
          });
      }).pipe(
        Effect.raceFirst(
          terminated.pipe(
            Effect.andThen(
              new CodexThreadReleaseError({
                message: "Codex exited before release was confirmed.",
              }),
            ),
          ),
        ),
        Effect.timeout("90 seconds"),
        Effect.ensuring(
          Effect.sync(() => {
            if (waiting.get(nativeId) === signal) waiting.delete(nativeId);
          }),
        ),
      );
    }),
  };
}
