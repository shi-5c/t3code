import { assert, it } from "@effect/vitest";
import * as Contracts from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { sharedCodexAdapter } from "./SharedCodexAdapter.ts";

it.effect(
  "isolates shared execution routes and never falls back after a follower or ownership error",
  () =>
    Effect.gen(function* () {
      const instanceId = Contracts.ProviderInstanceId.make("codex-desktop");
      const threadId = Contracts.ThreadId.make("shared-thread");
      const nativeCalls: string[] = [];
      const followerCalls: string[] = [];
      let disconnected = false;
      let bound = false;
      const nativeRuntime = {
        providerSessionId: "native-session",
      } as Adapter.ProviderAdapterV2SessionRuntime;
      const followerRuntime = {
        providerSessionId: "desktop-session:native",
      } as Adapter.ProviderAdapterV2SessionRuntime;
      const base = {
        instanceId,
        driver: Contracts.ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      };
      const adapter = sharedCodexAdapter(
        {
          ...base,
          openSession: (input) => {
            followerCalls.push(input.providerSessionId);
            return disconnected
              ? Effect.fail(
                  new Adapter.ProviderAdapterOpenSessionError({
                    driver: base.driver,
                    providerSessionId: input.providerSessionId,
                    cause: "owner disconnected",
                  }),
                )
              : Effect.succeed(followerRuntime);
          },
        },
        {
          ...base,
          openSession: (input) => {
            nativeCalls.push(input.providerSessionId);
            return Effect.succeed(nativeRuntime);
          },
        },
        () =>
          bound
            ? Effect.fail(
                new Contracts.CodexDesktopError({
                  message: "binding exists",
                  outcomeUnknown: false,
                }),
              )
            : Effect.void,
      );
      const caps = yield* adapter.getCapabilities();
      assert.isFalse(caps.sessions.supportsMultipleProviderThreadsPerSession);
      assert.isTrue(caps.threads.canCreateEmptyThread);
      const input = {
        threadId,
        providerSessionId: Contracts.ProviderSessionId.make("native-session"),
        modelSelection: { instanceId, model: "fixture" },
        runtimePolicy: {
          cwd: "/workspace",
          runtimeMode: "approval-required" as const,
          interactionMode: "default" as const,
        },
      };
      assert.strictEqual(
        yield* adapter.openSession({ ...input, codexSharedOwner: "native" }),
        nativeRuntime,
      );
      const following = {
        ...input,
        providerSessionId: Contracts.ProviderSessionId.make("desktop-session:native"),
      };
      assert.strictEqual(
        yield* adapter.openSession({ ...following, codexSharedOwner: "desktop" }),
        followerRuntime,
      );
      // Missing ownership is legacy follower state, never permission to start another writer.
      assert.strictEqual(yield* adapter.openSession(following), followerRuntime);
      disconnected = true;
      assert.equal(
        (yield* adapter.openSession(following).pipe(Effect.flip)).cause,
        "owner disconnected",
      );
      bound = true;
      const denied = yield* adapter
        .openSession({ ...input, codexSharedOwner: "native" })
        .pipe(Effect.flip);
      assert.equal((denied.cause as Contracts.CodexDesktopError).message, "binding exists");
      assert.deepEqual(nativeCalls, ["native-session"]);
      assert.equal(followerCalls.length, 3);
    }).pipe(Effect.scoped),
);
