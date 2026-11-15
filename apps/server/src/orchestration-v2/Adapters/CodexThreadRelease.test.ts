import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { makeCodexThreadRelease } from "./CodexThreadRelease.ts";

it.effect.each(["before-ack", "after-ack", "wrong-id", "still-loaded", "exit", "timeout"] as const)(
  "confirms a shared native release only after the matching close and ACK (%s)",
  (order) =>
    Effect.gen(function* () {
      const terminated = yield* Deferred.make<void>();
      const requested = yield* Deferred.make<void>();
      const ack = yield* Deferred.make<void>();
      const release = makeCodexThreadRelease(Deferred.await(terminated));
      const confirmed = yield* Deferred.make<void>();
      const operation = release.confirm(
        "native-one",
        Effect.gen(function* () {
          yield* Deferred.succeed(requested, undefined);
          yield* Deferred.await(ack);
        }),
        Effect.succeed(order === "still-loaded"),
      );
      const fiber = yield* operation.pipe(
        Effect.tap(() => Deferred.succeed(confirmed, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(requested);
      if (order === "before-ack") {
        yield* release.closed("native-one");
        yield* release.closed("native-one");
        assert.isFalse(yield* Deferred.isDone(confirmed));
      }
      yield* Deferred.succeed(ack, undefined);
      if (order === "after-ack" || order === "still-loaded") yield* release.closed("native-one");
      if (order === "wrong-id") yield* release.closed("native-other");
      if (order === "exit") yield* Deferred.succeed(terminated, undefined);
      if (order === "timeout" || order === "wrong-id") yield* TestClock.adjust("91 seconds");
      const result = yield* Fiber.await(fiber);
      assert.equal(Exit.isSuccess(result), order === "before-ack" || order === "after-ack");
      // A duplicate from an earlier release cannot confirm the next generation.
      yield* release.closed("native-one");
      const next = yield* release
        .confirm("native-one", Effect.void, Effect.succeed(false))
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("91 seconds");
      assert.isTrue(Exit.isFailure(yield* Fiber.await(next)));
    }),
);
