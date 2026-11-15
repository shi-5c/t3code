import * as Contracts from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as Commands from "../orchestration-v2/ThreadCommandExecutor.ts";
import { DesktopHistoryLibrary } from "./DesktopHistoryLibrary.ts";
import { DESKTOP_INSTANCE_ID } from "./identity.ts";
import { observeNativeTitle } from "./sharedTitle.ts";

const titleSemantics = (thread: Contracts.OrchestrationV2AppThread) => {
  const sync = thread.codexTitleSync;
  return stableStringify({
    title: thread.title,
    titleRegeneration: thread.titleRegeneration,
    codexTitleSync: sync?.nativeSaved
      ? {
          ...sync,
          nativeSaved: { ...sync.nativeSaved, read: { ...sync.nativeSaved.read, revision: 0 } },
        }
      : sync,
  });
};

export class NativeTitleFollow extends Context.Service<
  NativeTitleFollow,
  {
    readonly acquire: (threadId: Contracts.ThreadId) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/codexDesktop/NativeTitleFollow") {}

/** One consumer-owned worker per viewed chat; no background scan and no native write dependency. */
export const layer = Layer.effect(
  NativeTitleFollow,
  Effect.gen(function* () {
    const library = yield* DesktopHistoryLibrary;
    const projections = yield* Projections.ProjectionStoreV2;
    const sink = yield* Sink.EventSinkV2;
    const commands = yield* Commands.ThreadCommandExecutor;
    const serviceScope = yield* Scope.Scope;
    const consumers = new Map<Contracts.ThreadId, { refs: number; fiber: Fiber.Fiber<void> }>();
    const consumerLock = yield* Semaphore.make(1);
    const readerLock = yield* Semaphore.make(1);
    let nextStart = 0;
    const inspect = Effect.fn("NativeTitleFollow.inspect")(function* (
      threadId: Contracts.ThreadId,
    ) {
      const records = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
      const thread = records.thread;
      const provider = records.providerThreads.find(
        (row) => row.id === thread.activeProviderThreadId,
      );
      if (
        thread.deletedAt !== null ||
        Contracts.threadTypeOf(thread) !== "codex-shared" ||
        thread.providerInstanceId !== DESKTOP_INSTANCE_ID ||
        provider?.providerInstanceId !== DESKTOP_INSTANCE_ID ||
        provider.driver !== "codex" ||
        !provider.nativeThreadRef?.nativeId ||
        provider.nativeMetadata?.codexSharedCreationPending
      )
        return null;
      const nativeId = provider.nativeThreadRef.nativeId;
      const origin = thread.codexDesktopHistory;
      const previous = thread.codexTitleSync?.nativeSaved?.read;
      if ((origin && origin.nativeId !== nativeId) || (previous && previous.nativeId !== nativeId))
        return null;
      return { thread, provider, nativeId, sourceId: origin?.sourceId ?? previous?.sourceId };
    });
    const poll = Effect.fn("NativeTitleFollow.poll")(function* (threadId: Contracts.ThreadId) {
      return yield* readerLock.withPermit(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* Effect.sleep(Math.max(0, nextStart - DateTime.toEpochMillis(now)));
          const original = yield* inspect(threadId);
          if (!original) return;
          if (
            original.sourceId &&
            !(yield* library.mayProject(
              original.sourceId,
              original.thread.codexDesktopHistory ? original.nativeId : undefined,
            ))
          )
            return;
          nextStart = DateTime.toEpochMillis(yield* DateTime.now) + 5_000;
          const read = yield* library.observeTitle(
            original.nativeId,
            original.sourceId,
            !!original.thread.codexDesktopHistory,
          );
          if (
            !read ||
            read.nativeId !== original.nativeId ||
            (original.sourceId && read.sourceId !== original.sourceId)
          )
            return;
          yield* commands
            .withLock(
              threadId,
              sink.withProviderBatch(
                Effect.gen(function* () {
                  const latest = yield* inspect(threadId);
                  if (
                    !latest ||
                    latest.nativeId !== original.nativeId ||
                    latest.provider.id !== original.provider.id ||
                    latest.thread.codexSharedOwner !== original.thread.codexSharedOwner ||
                    latest.provider.providerSessionId !== original.provider.providerSessionId ||
                    (latest.sourceId && latest.sourceId !== read.sourceId)
                  )
                    return;
                  // The private watermark advances even when the last published revision stays unchanged.
                  if (!(yield* library.isCurrentTitle(read, !!latest.thread.codexDesktopHistory)))
                    return;
                  const nativeTitle = latest.provider.nativeMetadata?.codexNativeTitle;
                  const release = latest.provider.nativeMetadata?.codexSharedRelease;
                  const unchanged =
                    original.thread.title === latest.thread.title &&
                    stableStringify([
                      original.thread.codexTitleSync?.version,
                      original.thread.codexTitleSync?.source,
                      original.thread.codexTitleSync?.desiredTitle,
                    ]) ===
                      stableStringify([
                        latest.thread.codexTitleSync?.version,
                        latest.thread.codexTitleSync?.source,
                        latest.thread.codexTitleSync?.desiredTitle,
                      ]);
                  // A successful native write may still be waiting for Desktop's in-memory owner to display it.
                  const savedIntent =
                    nativeTitle?.status === "saved" &&
                    nativeTitle.desiredTitle === latest.thread.title &&
                    nativeTitle.version === (latest.thread.codexTitleSync?.version ?? 0);
                  const patch = observeNativeTitle(
                    latest.thread,
                    read,
                    unchanged,
                    (!nativeTitle || nativeTitle.status === "saved") &&
                      (!release || release.state === "ready" || release.state === "held"),
                    savedIntent,
                  );
                  if (
                    Object.keys(patch).length === 0 ||
                    titleSemantics(latest.thread) === titleSemantics({ ...latest.thread, ...patch })
                  )
                    return;
                  const occurredAt = yield* DateTime.now;
                  yield* sink.write({
                    events: [
                      {
                        id: Contracts.EventId.make(`native-title:${yield* randomUuidV4}`),
                        type: "thread.metadata-updated",
                        threadId,
                        occurredAt,
                        payload: { ...latest.thread, ...patch },
                      },
                    ],
                  });
                }),
              ),
            )
            .pipe(library.withProjection);
        }),
      );
    });
    return {
      acquire: Effect.fn("NativeTitleFollow.acquire")(function* (threadId) {
        // Registration and final release serialize; the finalizer waits for the reader's process cleanup.
        yield* Effect.acquireRelease(
          consumerLock.withPermit(
            Effect.gen(function* () {
              const existing = consumers.get(threadId);
              if (existing) {
                existing.refs++;
                return true;
              }
              const first = yield* projections
                .getThreadRecords(threadId, [])
                .pipe(Effect.orElseSucceed(() => null));
              if (
                !first ||
                first.thread.deletedAt !== null ||
                Contracts.threadTypeOf(first.thread) !== "codex-shared" ||
                first.thread.providerInstanceId !== DESKTOP_INSTANCE_ID
              )
                return false;
              const fiber = yield* poll(threadId).pipe(
                Effect.catch((cause) =>
                  Effect.logDebug("Native title observation paused", { cause }),
                ),
                Effect.andThen(Effect.sleep("30 seconds")),
                Effect.forever,
                Effect.interruptible,
                Effect.forkIn(serviceScope),
              );
              consumers.set(threadId, { refs: 1, fiber });
              return true;
            }),
          ),
          (registered) =>
            consumerLock.withPermit(
              Effect.gen(function* () {
                if (!registered) return;
                const entry = consumers.get(threadId);
                if (!entry) return;
                entry.refs--;
                if (entry.refs === 0) {
                  yield* Fiber.interrupt(entry.fiber);
                  consumers.delete(threadId);
                }
              }),
            ),
        );
      }),
    };
  }),
);
