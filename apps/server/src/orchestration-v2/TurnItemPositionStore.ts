import { OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class TurnItemPositionStoreError extends Schema.TaggedError<TurnItemPositionStoreError>()(
  "TurnItemPositionStoreError",
  {
    threadId: ThreadId,
    turnItemId: TurnItemId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isTurnItemPositionStoreError = Schema.is(TurnItemPositionStoreError);

export interface TurnItemPositionStoreV2Shape {
  readonly allocate: (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
    readonly runId: RunId | null;
    readonly runOrdinal?: number;
  }) => Effect.Effect<number, TurnItemPositionStoreError>;
  readonly normalize: (
    item: OrchestrationV2TurnItem,
    runOrdinal?: number,
  ) => Effect.Effect<OrchestrationV2TurnItem, TurnItemPositionStoreError>;
  /** Caller holds the event transaction; free all moving observations before assigning canonical positions. */
  readonly reconcileNativeHistory: (
    items: ReadonlyArray<OrchestrationV2TurnItem>,
  ) => Effect.Effect<void, TurnItemPositionStoreError>;
}

export class TurnItemPositionStoreV2 extends Context.Service<
  TurnItemPositionStoreV2,
  TurnItemPositionStoreV2Shape
>()("t3/orchestration-v2/TurnItemPositionStore/TurnItemPositionStoreV2") {}

export const layer: Layer.Layer<TurnItemPositionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  TurnItemPositionStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const allocate: TurnItemPositionStoreV2Shape["allocate"] =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(
        function* ({ threadId, turnItemId, runId, runOrdinal: suppliedRunOrdinal }) {
          const existing = yield* sql<{ readonly ordinal: number }>`
          SELECT ordinal
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
          LIMIT 1
        `;
          if (existing[0] !== undefined) return existing[0].ordinal;

          const runRows =
            runId === null
              ? []
              : yield* sql<{ readonly ordinal: number }>`
                SELECT ordinal
                FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId} AND run_id = ${runId}
                LIMIT 1
              `;
          const runOrdinal = suppliedRunOrdinal ?? runRows[0]?.ordinal ?? null;
          const lowerBound = runOrdinal === null ? 0 : runOrdinal * 1_000_000;
          // The upper half of each interval holds saved native observations between runs.
          const upperBound = lowerBound + 499_999;
          yield* sql`
          INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
          SELECT
            ${threadId},
            ${turnItemId},
            COALESCE(MAX(ordinal), ${lowerBound}) + 1
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId}
            AND ordinal >= ${lowerBound}
            AND ordinal <= ${upperBound}
          ON CONFLICT(thread_id, turn_item_id) DO NOTHING
        `;
          const rows = yield* sql<{ readonly ordinal: number }>`
          SELECT ordinal
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
          LIMIT 1
        `;
          const ordinal = rows[0]?.ordinal;
          if (ordinal === undefined || ordinal > upperBound) {
            return yield* new TurnItemPositionStoreError({
              threadId,
              turnItemId,
              cause: "Position allocation returned no row or exhausted the run interval.",
            });
          }
          return ordinal;
        },
        (effect, { threadId, turnItemId }) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isTurnItemPositionStoreError(cause)
                ? cause
                : new TurnItemPositionStoreError({ threadId, turnItemId, cause }),
            ),
          ),
      );

    return TurnItemPositionStoreV2.of({
      allocate,
      reconcileNativeHistory: Effect.fn("TurnItemPositionStore.reconcileNativeHistory")(
        function* (items) {
          const observed = [
            ...new Map(
              items
                .filter(
                  (item) =>
                    item.runId === null &&
                    item.id.startsWith("codex-history:") &&
                    item.nativeHistoryPosition !== undefined,
                )
                .map((item) => [item.id, item]),
            ).values(),
          ];
          if (!observed.length) return;
          const moving: Array<{ item: OrchestrationV2TurnItem; ordinal: number }> = [];
          yield* Effect.gen(function* () {
            for (const item of observed) {
              const position = item.nativeHistoryPosition!;
              const rows =
                position.afterRunId === null
                  ? []
                  : yield* sql<{
                      ordinal: number;
                    }>`SELECT ordinal FROM orchestration_v2_projection_runs WHERE thread_id = ${item.threadId} AND run_id = ${position.afterRunId}`;
              if (position.index >= 500_000 || (position.afterRunId !== null && !rows[0]))
                return yield* new TurnItemPositionStoreError({
                  threadId: item.threadId,
                  turnItemId: item.id,
                  cause:
                    "Native history position has no valid local anchor or exceeds its interval.",
                });
              const ordinal = (rows[0]?.ordinal ?? 0) * 1_000_000 + 500_000 + position.index;
              const current = yield* sql<{
                ordinal: number;
              }>`SELECT ordinal FROM orchestration_v2_turn_item_positions WHERE thread_id = ${item.threadId} AND turn_item_id = ${item.id}`;
              if (current[0]?.ordinal !== ordinal) moving.push({ item, ordinal });
            }
            // The table has a unique position constraint. Temporary negative positions
            // permit A/B insertions and swaps without overwriting another observation.
            for (const { item } of moving)
              yield* sql`UPDATE orchestration_v2_turn_item_positions SET ordinal = -rowid WHERE thread_id = ${item.threadId} AND turn_item_id = ${item.id}`;
            for (const { item, ordinal } of moving)
              yield* sql`INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal) VALUES (${item.threadId}, ${item.id}, ${ordinal}) ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET ordinal = excluded.ordinal`;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new TurnItemPositionStoreError({
                  threadId: observed[0]!.threadId,
                  turnItemId: observed[0]!.id,
                  cause,
                }),
            ),
          );
        },
      ),
      // Per-event normalization shares the enclosing orchestration span.
      normalize: Effect.fnUntraced(function* (item, runOrdinal) {
        return yield* allocate({
          threadId: item.threadId,
          turnItemId: item.id,
          runId: item.runId,
          ...(runOrdinal === undefined ? {} : { runOrdinal }),
        }).pipe(Effect.map((ordinal) => (item.ordinal === ordinal ? item : { ...item, ordinal })));
      }),
    });
  }),
);
