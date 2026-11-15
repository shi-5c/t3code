import * as Effect from "effect/Effect";
import { CodexDesktopError } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import type { DesktopHistoryStore } from "./DesktopHistoryStore.ts";
const database = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: () =>
      new CodexDesktopError({
        message: "The verified Desktop history source could not be read or saved.",
        outcomeUnknown: false,
      }),
  });

/** Only the last verified source for this exact configured home may serve an offline cache. */
export const resolveDesktopHistorySource = Effect.fn("DesktopHistorySourceScope.resolve")(
  function* <E>(input: {
    configuredHome: string;
    realPath: Effect.Effect<string, E>;
    store: DesktopHistoryStore;
  }) {
    const alias = normalizeProjectPathForComparison(input.configuredHome);
    const physical = yield* Effect.result(input.realPath);
    if (physical._tag === "Failure") {
      const source = yield* database(() => input.store.sourceFor(alias));
      if (source === null) return yield* Effect.fail(physical.failure);
      return {
        source,
        available: false,
        error: "The verified Desktop source is unavailable. Showing its saved history.",
      };
    }
    const source = normalizeProjectPathForComparison(physical.success);
    yield* database(() => input.store.rememberSource(alias, source));
    return { source, available: true, error: null as string | null };
  },
);
