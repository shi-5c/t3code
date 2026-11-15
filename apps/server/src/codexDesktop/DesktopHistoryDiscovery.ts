import * as Effect from "effect/Effect";
import { CodexDesktopError } from "@t3tools/contracts";
import type { DesktopHistoryCandidate, DesktopHistoryStore } from "./DesktopHistoryStore.ts";
const database = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: () =>
      new CodexDesktopError({
        message: "The Desktop history cache could not be updated. Saved history is retained.",
        outcomeUnknown: false,
      }),
  });

/** Commit each discovery source independently; a failed list never blocks known-ID reads. */
export const discoverDesktopHistory = Effect.fn("DesktopHistoryDiscovery.discover")(function* <
  E1,
  E2,
  E3,
>(input: {
  store: DesktopHistoryStore;
  source: string;
  now: number;
  local: Effect.Effect<ReadonlyArray<DesktopHistoryCandidate>, E1>;
  api: Effect.Effect<ReadonlyArray<DesktopHistoryCandidate>, E2>;
  rollouts?: Effect.Effect<
    { rows: ReadonlyArray<DesktopHistoryCandidate>; error: string | null },
    E3
  >;
  mayCommit?: Effect.Effect<boolean>;
  withCommit?: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}) {
  const known = new Map<string, DesktopHistoryCandidate>(
    (yield* database(() => input.store.list(input.source))).map((row) => [
      row.conversationId,
      {
        conversationId: row.conversationId,
        title: row.title,
        cwd: row.cwd,
        archived: row.archived,
        updatedAt: row.updatedAt,
        membership: row.membership,
        attachedToThreadId: row.attachedToThreadId ?? null,
      },
    ]),
  );
  const sources: ReadonlyArray<
    readonly [
      "local" | "api" | "rollout",
      Effect.Effect<
        { rows: ReadonlyArray<DesktopHistoryCandidate>; error: string | null },
        E1 | E2 | E3
      >,
    ]
  > = [
    ...(input.rollouts ? [["rollout", input.rollouts] as const] : []),
    ["local", input.local.pipe(Effect.map((rows) => ({ rows, error: null })))],
    ["api", input.api.pipe(Effect.map((rows) => ({ rows, error: null })))],
  ];
  for (const [kind, read] of sources) {
    yield* read.pipe(
      Effect.flatMap(({ rows, error }) =>
        (input.withCommit ?? ((effect) => effect))(
          Effect.gen(function* () {
            if (input.mayCommit && !(yield* input.mayCommit)) return;
            // Rollout headers only seed candidates. A filename/creation header cannot downgrade
            // a canonical title, workspace, or the attachment gate when richer discovery fails.
            const merged = rows.map((row) => {
              const previous = known.get(row.conversationId);
              return kind === "rollout" && previous
                ? {
                    ...previous,
                    classification: row.classification ?? {},
                    attachedToThreadId:
                      previous.attachedToThreadId || row.attachedToThreadId || null,
                  }
                : { ...previous, ...row };
            });
            yield* database(() => input.store.discover(input.source, merged, input.now));
            for (const row of merged) known.set(row.conversationId, row);
            yield* database(() =>
              input.store.discoveryResult(input.source, kind, input.now, error),
            );
          }),
        ),
      ),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          if (input.mayCommit && !(yield* input.mayCommit)) return;
          yield* database(() =>
            input.store.discoveryResult(
              input.source,
              kind,
              input.now,
              cause instanceof Error
                ? cause.message
                : "Discovery source is unavailable; cached history is retained.",
            ),
          );
        }),
      ),
    );
  }
});
