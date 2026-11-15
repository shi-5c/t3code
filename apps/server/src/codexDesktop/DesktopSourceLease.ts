import * as Contracts from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as Settings from "../serverSettings.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { desktopHistorySourceId } from "./DesktopHistoryStore.ts";
import { DESKTOP_INSTANCE_ID } from "./identity.ts";

const decodeSettings = Schema.decodeEffect(Contracts.CodexSettings);
const failure = (cause: unknown) =>
  new Contracts.CodexDesktopError({
    message: cause instanceof Error ? cause.message : "The Share data source is unavailable.",
    outcomeUnknown: false,
  });

/** A follower lease stops local publication and new sends; it never interrupts a Desktop turn. */
export const makeDesktopSourceLeaseFactory = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const inspect = Effect.fn("DesktopSourceLease.inspect")(function* (desktopHome: string) {
    const provider = (yield* settings.getSettings).providerInstances[
      Contracts.ProviderInstanceId.make(DESKTOP_INSTANCE_ID)
    ];
    if (!provider || provider.driver !== "codex" || provider.enabled === false)
      return yield* failure(new Error("Codex Desktop Share is disabled or unavailable."));
    const config = yield* decodeSettings(provider.config ?? {});
    if (
      config.setupMode !== "existing" ||
      config.shadowHomePath.trim() ||
      config.launchArgs.trim() ||
      provider.environment?.some(
        (entry) => entry.name.toUpperCase() === "CODEX_HOME" && typeof entry.value !== "string",
      )
    )
      return yield* failure(
        new Error("Share requires the verified Desktop data directory without launch overrides."),
      );
    const env = yield* mergeProviderInstanceEnvironment(provider.environment, environment);
    const layout = yield* resolveCodexHomeLayout(
      !config.homePath.trim() && env.CODEX_HOME?.trim()
        ? { ...config, homePath: env.CODEX_HOME }
        : config,
    ).pipe(Effect.provideService(Path.Path, path));
    const source = normalizeProjectPathForComparison(yield* fs.realPath(desktopHome));
    if (normalizeProjectPathForComparison(yield* fs.realPath(layout.sharedHomePath)) !== source)
      return yield* failure(
        new Error(
          "Share and Codex Desktop now use different data directories. Reconnect after restoring the source.",
        ),
      );
    return {
      config: stableStringify(provider),
      source,
      sourceId: desktopHistorySourceId(source),
      provider,
    };
  }, Effect.mapError(failure));
  return Effect.fn("DesktopSourceLease.acquire")(function* (
    desktopHome: string,
    expectedSourceId?: string,
  ) {
    const initial = yield* inspect(desktopHome);
    if (expectedSourceId !== undefined && initial.sourceId !== expectedSourceId)
      return yield* failure(
        new Error("This saved chat belongs to a different Desktop data source."),
      );
    const assertCurrent = inspect(desktopHome).pipe(
      Effect.flatMap((current) =>
        current.config === initial.config && current.source === initial.source
          ? Effect.void
          : Effect.fail(
              failure(
                new Error("The Share configuration changed. Reconnect before sending or syncing."),
              ),
            ),
      ),
    );
    return {
      sourceId: initial.sourceId,
      source: { provider: initial.provider, homePath: initial.source },
      assertCurrent,
    };
  });
});
