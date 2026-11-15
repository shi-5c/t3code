import { codexSharedOwnerOf, type OrchestrationV2ProviderThread } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

type NativeTitle = NonNullable<
  NonNullable<OrchestrationV2ProviderThread["nativeMetadata"]>["codexNativeTitle"]
>;

export const makeNativeSharedTitlePreparation = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;

  return Effect.fn("NativeSharedTitle.prepare")(
    function* (
      owner: OrchestrationV2ProviderThread,
      io: ProviderAdapter.ProviderAdapterV2SessionRuntime["nativeTitle"],
    ) {
      const threadId = owner.appThreadId;
      if (!io || threadId === null) return true;
      const records = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
      const current = records.providerThreads.find((row) => row.id === owner.id);
      const thread = records.thread;
      if (
        codexSharedOwnerOf(thread) !== "native" ||
        !current ||
        thread.activeProviderThreadId !== current.id ||
        current.nativeThreadRef?.nativeId !== owner.nativeThreadRef?.nativeId ||
        !current.nativeThreadRef?.nativeId ||
        current.nativeMetadata?.codexSharedCreationPending ||
        current.providerSessionId !== owner.providerSessionId
      )
        return true;
      if (thread.titleRegeneration) return false;
      const desiredTitle = thread.title;
      if (!desiredTitle.trim()) return true;
      const version = thread.codexTitleSync?.version ?? 0;
      const previous = current.nativeMetadata?.codexNativeTitle;
      const unresolved = previous?.status === "pending" || previous?.status === "unknown";
      // A read-side adoption is never a write intent, including after restart/release recovery.
      // Uncertain older writes still need reconciliation before releasing the native owner.
      if (thread.codexTitleSync?.source === "saved" && !unresolved)
        return previous?.status !== "unverified";
      const processIdentity = io.process ? yield* io.process : undefined;
      const read = yield* io.read(current).pipe(Effect.timeout(5_000), Effect.result);
      const observedTitle = Result.isSuccess(read) ? read.success : null;
      const terminated =
        unresolved && previous.process && io.hasExited
          ? yield* io.hasExited(previous.process)
          : false;
      const expectedTitle =
        previous?.status === "saved" || previous?.status === "unverified"
          ? previous.desiredTitle
          : (current.nativeMetadata?.title ?? null);
      const mayWrite =
        thread.codexTitleSync?.source !== "saved" &&
        Result.isSuccess(read) &&
        observedTitle === expectedTitle &&
        !unresolved;
      let state: NativeTitle = {
        version,
        desiredTitle,
        observedTitle,
        ...(processIdentity ? { process: processIdentity } : {}),
        status:
          unresolved && !terminated
            ? "unknown"
            : Result.isFailure(read)
              ? "unavailable"
              : terminated
                ? observedTitle === desiredTitle
                  ? "saved"
                  : "conflict"
                : observedTitle === desiredTitle
                  ? "saved"
                  : mayWrite
                    ? processIdentity
                      ? "pending"
                      : "unavailable"
                    : "conflict",
      };
      // Preserve the uncertain operation's identity so a later read can reconcile it without replay.
      if (state.status === "unknown" && previous)
        state = { ...previous, status: "unknown", observedTitle };

      const store = Effect.fn("NativeSharedTitle.store")(function* (
        value: NativeTitle,
        initial: boolean,
      ) {
        const latest = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
        const row = latest.providerThreads.find((candidate) => candidate.id === current.id);
        if (
          !row ||
          codexSharedOwnerOf(latest.thread) !== "native" ||
          latest.thread.activeProviderThreadId !== row.id ||
          row.nativeThreadRef?.nativeId !== current.nativeThreadRef?.nativeId ||
          row.providerSessionId !== current.providerSessionId
        )
          return false;
        if (
          initial &&
          (latest.thread.title !== thread.title ||
            (latest.thread.codexTitleSync?.version ?? 0) !== version)
        )
          return false;
        if (
          !initial &&
          (row.nativeMetadata?.codexNativeTitle?.version !== version ||
            row.nativeMetadata.codexNativeTitle.desiredTitle !== desiredTitle)
        )
          return false;
        const now = yield* DateTime.now;
        return (yield* sink.writeIfProviderThreadUnchanged({
          expected: row,
          ...(initial ? { expectedSharedTitle: { title: thread.title, version } } : {}),
          events: [
            {
              id: yield* ids.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...row,
                updatedAt: now,
                nativeMetadata: { ...row.nativeMetadata, codexNativeTitle: value },
              },
            },
          ],
        })).committed;
      });
      if (!(yield* store(state, true))) return false;
      if (state.status === "pending") {
        // name/set has no CAS. Never overwrite an observed external rename or retry an ambiguous write.
        const written = yield* io
          .write(current, desiredTitle)
          .pipe(Effect.timeout(5_000), Effect.result);
        const readBack = yield* io.read(current).pipe(Effect.timeout(5_000), Effect.result);
        const actual = Result.isSuccess(readBack) ? readBack.success : null;
        state = {
          ...state,
          observedTitle: actual,
          status: Result.isFailure(written)
            ? "unknown"
            : Result.isFailure(readBack)
              ? "unverified"
              : actual === desiredTitle
                ? "saved"
                : "conflict",
        };
        if (!(yield* store(state, false))) return false;
      }
      if (state.status === "unknown" || state.status === "pending" || state.status === "unverified")
        return false;
      const latest = yield* projections.getThreadRecords(threadId, []);
      return (
        latest.thread.title === thread.title &&
        (latest.thread.codexTitleSync?.version ?? 0) === version
      );
    },
    Effect.catch((cause) =>
      Effect.logWarning("Native title preparation could not be confirmed", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );
});
