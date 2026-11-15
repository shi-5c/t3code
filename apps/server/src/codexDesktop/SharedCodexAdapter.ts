import type * as Contracts from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

/** Route once from persisted ownership. A failed follower never opens a native writer. */
export function sharedCodexAdapter(
  follower: Adapter.ProviderAdapterV2["Service"],
  native: Adapter.ProviderAdapterV2["Service"],
  checkNative: (threadId: Contracts.ThreadId) => Effect.Effect<void, Contracts.CodexDesktopError>,
): Adapter.ProviderAdapterV2["Service"] {
  return {
    ...follower,
    // Session allocation uses this capability before choosing an execution mode.
    // Keep distinct sessions even though the native runtime can host multiple threads.
    getCapabilities: () =>
      follower.getCapabilities().pipe(
        Effect.map((capabilities) => ({
          ...capabilities,
          threads: { ...capabilities.threads, canCreateEmptyThread: true },
          sessions: { ...capabilities.sessions, supportsMultipleProviderThreadsPerSession: false },
        })),
      ),
    openSession: Effect.fn("SharedCodexAdapter.openSession")(function* (input) {
      if (input.codexSharedOwner !== "native") return yield* follower.openSession(input);
      yield* checkNative(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new Adapter.ProviderAdapterOpenSessionError({
              driver: native.driver,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      return yield* native.openSession(input);
    }),
  };
}
