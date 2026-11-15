import {
  CodexDesktopError,
  CodexSettings,
  ProviderInstanceId,
  type CodexDesktopHistoryEntry,
  type CodexDesktopHistoryLibraryState,
  type CodexDesktopHistoryPageInput,
  type CodexDesktopHistoryPage,
  type CodexNativeTitleRead,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  CodexSessionHistory,
  CodexSessionHistoryError,
  type CodexHistory,
} from "../project/CodexSessionHistory.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import {
  DesktopHistoryStore,
  desktopHistorySourceId,
  type DesktopHistoryCandidate,
} from "./DesktopHistoryStore.ts";
import { desktopHistoryMembership } from "./DesktopHistoryMembership.ts";
import {
  readDesktopHistoryCandidates,
  readDesktopMembershipCache,
} from "./DesktopHistorySource.ts";
import { DESKTOP_INSTANCE_ID } from "./identity.ts";
import { discoverDesktopHistory } from "./DesktopHistoryDiscovery.ts";
import { resolveDesktopHistorySource } from "./DesktopHistorySourceScope.ts";
import { desktopHistoryPage } from "./DesktopHistoryPage.ts";
import { readDesktopRolloutCandidates } from "./DesktopRolloutDiscovery.ts";
import { makeDesktopSourceLeaseFactory } from "./DesktopSourceLease.ts";
import { classifyDesktopHistory } from "./DesktopHistoryClassification.ts";

const instanceId = ProviderInstanceId.make(DESKTOP_INSTANCE_ID);
const decodeSettings = Schema.decodeEffect(CodexSettings);
const isHistoryError = Schema.is(CodexSessionHistoryError);
const failure = (cause: unknown) =>
  new CodexDesktopError({
    message: cause instanceof Error ? cause.message : "Desktop history is unavailable.",
    outcomeUnknown: false,
  });
export class DesktopHistoryLibrary extends Context.Service<
  DesktopHistoryLibrary,
  {
    readonly list: Effect.Effect<ReadonlyArray<CodexDesktopHistoryEntry>, CodexDesktopError>;
    readonly read: (
      id: string,
      sourceId?: string,
    ) => Effect.Effect<CodexHistory | null, CodexDesktopError>;
    readonly state: Effect.Effect<CodexDesktopHistoryLibraryState, CodexDesktopError>;
    readonly page: (
      input: CodexDesktopHistoryPageInput,
    ) => Effect.Effect<CodexDesktopHistoryPage, CodexDesktopError>;
    readonly refresh: Effect.Effect<void, CodexDesktopError>;
    readonly mayProject: (sourceId: string, nativeId?: string) => Effect.Effect<boolean>;
    readonly withProjection: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly isCurrentTitle: (
      read: CodexNativeTitleRead,
      requireHistoryAdmission?: boolean,
    ) => Effect.Effect<boolean>;
    readonly observeTitle: (
      nativeId: string,
      sourceId?: string,
      requireHistoryAdmission?: boolean,
    ) => Effect.Effect<CodexNativeTitleRead | null, CodexDesktopError>;
  }
>()("t3/codexDesktop/DesktopHistoryLibrary") {}

export const layer = Layer.effect(
  DesktopHistoryLibrary,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scope = yield* Scope.Scope;
    const environment = yield* HostProcess.Environment;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const settings = yield* ServerSettings.ServerSettingsService;
    const history = yield* CodexSessionHistory;
    const acquireLease = yield* makeDesktopSourceLeaseFactory;
    const lock = yield* Semaphore.make(1);
    const publicationLock = yield* Semaphore.make(1);
    const desktopHome = environment.CODEX_HOME || path.join(homeDirectory, ".codex");
    const storeLock = yield* Semaphore.make(1);
    let openedStore: DesktopHistoryStore | undefined;
    const getStore = storeLock.withPermit(
      Effect.suspend(() =>
        openedStore
          ? Effect.succeed(openedStore)
          : Effect.acquireRelease(
              fs.makeDirectory(config.stateDir, { recursive: true }).pipe(
                Effect.andThen(
                  Effect.try({
                    try: () =>
                      new DesktopHistoryStore(
                        path.join(config.stateDir, "codex-desktop-history.sqlite"),
                      ),
                    catch: failure,
                  }),
                ),
                Effect.mapError(failure),
              ),
              (store) => Effect.sync(() => store.close()),
            ).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.tap((store) =>
                Effect.sync(() => {
                  openedStore = store;
                }),
              ),
            ),
      ).pipe(Effect.uninterruptible),
    );
    const source = Effect.gen(function* () {
      return yield* resolveDesktopHistorySource({
        configuredHome: path.resolve(desktopHome),
        realPath: fs.realPath(desktopHome),
        store: yield* getStore,
      });
    }).pipe(Effect.mapError(failure));
    let lastDiscovery = Number.NEGATIVE_INFINITY;
    let lastSource = "";
    const refresh = Effect.gen(function* () {
      const changes = yield* settings.subscribeChanges;
      const provider = (yield* settings.getSettings).providerInstances[instanceId];
      // An explicitly enabled Share provider is the admission point for automatic local caching.
      if (!provider || provider.driver !== "codex" || provider.enabled === false) return;
      const providerConfig = yield* decodeSettings(provider.config ?? {});
      if (
        providerConfig.setupMode !== "existing" ||
        providerConfig.shadowHomePath.trim() ||
        providerConfig.launchArgs.trim()
      )
        return yield* failure(
          new Error("History sync requires the existing Desktop home without launch overrides."),
        );
      if (
        provider.environment?.some(
          (entry) => entry.name.toUpperCase() === "CODEX_HOME" && typeof entry.value !== "string",
        )
      )
        return yield* failure(
          new Error("Resolve the Share provider's CODEX_HOME before syncing history."),
        );
      const env = yield* mergeProviderInstanceEnvironment(provider.environment, environment);
      const layout = yield* resolveCodexHomeLayout(
        !providerConfig.homePath.trim() && env.CODEX_HOME?.trim()
          ? { ...providerConfig, homePath: env.CODEX_HOME }
          : providerConfig,
      ).pipe(Effect.provideService(Path.Path, path));
      const scope = yield* source;
      if (!scope.available) return yield* failure(new Error(scope.error!));
      const sourceKey = scope.source;
      if (
        normalizeProjectPathForComparison(yield* fs.realPath(layout.sharedHomePath)) !== sourceKey
      )
        return yield* failure(
          new Error("Share history and Desktop use different data directories."),
        );
      const pinnedSource = { provider, homePath: sourceKey };
      let sourceInvalidated = false;
      const sourceChanged = changes.pipe(
        Stream.filter(
          (next) =>
            stableStringify(next.providerInstances[instanceId]) !== stableStringify(provider),
        ),
        Stream.runHead,
        Effect.flatMap((next) =>
          Option.isSome(next)
            ? Effect.sync(() => {
                sourceInvalidated = true;
              })
            : Effect.never,
        ),
      );
      const mayCommit = Effect.gen(function* () {
        if (sourceInvalidated) return false;
        const current = (yield* settings.getSettings).providerInstances[instanceId];
        if (stableStringify(current) !== stableStringify(provider)) return false;
        return normalizeProjectPathForComparison(yield* fs.realPath(desktopHome)) === sourceKey;
      }).pipe(Effect.orElseSucceed(() => false));
      yield* Effect.gen(function* () {
        const store = yield* getStore;
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const cache = yield* Effect.sync(() => readDesktopMembershipCache(desktopHome));
        if (sourceKey !== lastSource || now - lastDiscovery >= 60_000) {
          yield* discoverDesktopHistory({
            store,
            source: sourceKey,
            now,
            mayCommit,
            withCommit: (effect) => publicationLock.withPermit(effect),
            rollouts: Effect.tryPromise({
              try: (signal) => readDesktopRolloutCandidates(desktopHome, cache, signal),
              catch: failure,
            }),
            local: Effect.try({
              try: () => readDesktopHistoryCandidates(desktopHome, cache),
              catch: failure,
            }),
            api: Effect.gen(function* () {
              if (!history.discover)
                return yield* failure(new Error("Native discovery is unavailable in this reader."));
              const listed = yield* history.discover(instanceId, pinnedSource);
              const candidates: DesktopHistoryCandidate[] = [];
              for (const { thread, archived } of listed) {
                const candidate: DesktopHistoryCandidate = {
                  conversationId: thread.id,
                  title: typeof thread.name === "string" && thread.name ? thread.name : "Untitled",
                  cwd: typeof thread.cwd === "string" ? thread.cwd : "",
                  archived,
                  updatedAt:
                    typeof thread.updatedAt === "number" ? thread.updatedAt : thread.createdAt,
                  membership: desktopHistoryMembership(thread.id, thread.projectId, cache),
                  classification: { api: classifyDesktopHistory(thread) },
                };
                candidates.push(candidate);
              }
              return candidates;
            }),
          });
          lastDiscovery = now;
          lastSource = sourceKey;
        }
        const pending = yield* Effect.try({
          try: () => store.pending(sourceKey, now - 300_000, 10, now),
          catch: failure,
        });
        for (const candidate of pending) {
          if (!(yield* mayCommit)) break;
          const claimedAt = DateTime.toEpochMillis(yield* DateTime.now);
          if (
            !(yield* Effect.try({
              try: () => store.claim(sourceKey, candidate.conversationId, claimedAt),
              catch: failure,
            }))
          )
            continue;
          // Reader cwd is its verified home: missing historical workspaces remain readable.
          yield* history
            .read({
              providerInstanceId: instanceId,
              nativeThreadId: candidate.conversationId,
              cwd: sourceKey,
              source: pinnedSource,
            })
            .pipe(
              Effect.flatMap((value) =>
                Effect.gen(function* () {
                  if (!(yield* mayCommit)) return;
                  const completedAt = DateTime.toEpochMillis(yield* DateTime.now);
                  yield* Effect.try({
                    try: () =>
                      store.save(
                        sourceKey,
                        value,
                        desktopHistoryMembership(
                          candidate.conversationId,
                          value.canonical?.thread.projectId,
                          cache,
                        ),
                        completedAt,
                      ),
                    catch: failure,
                  });
                }).pipe(publicationLock.withPermit),
              ),
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  if (!(yield* mayCommit)) return;
                  const failedAt = DateTime.toEpochMillis(yield* DateTime.now);
                  yield* Effect.try({
                    try: () =>
                      store.failed(
                        sourceKey,
                        candidate.conversationId,
                        failedAt,
                        cause.message,
                        isHistoryError(cause) ? cause.reason : undefined,
                      ),
                    catch: failure,
                  });
                }),
              ),
            );
        }
      }).pipe(Effect.raceFirst(sourceChanged));
    }).pipe(Effect.scoped, Effect.mapError(failure), lock.withPermits(1));
    yield* forkParked(
      refresh.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Desktop history sync paused", { message: cause.message }),
        ),
        Effect.andThen(Effect.sleep("15 seconds")),
        Effect.forever,
      ),
    );
    const mayProject = Effect.fn("DesktopHistoryLibrary.mayProject")(
      function* (sourceId: string, nativeId?: string) {
        const provider = (yield* settings.getSettings).providerInstances[instanceId];
        if (!provider || provider.driver !== "codex" || provider.enabled === false) return false;
        const providerConfig = yield* decodeSettings(provider.config ?? {});
        if (
          providerConfig.setupMode !== "existing" ||
          providerConfig.shadowHomePath.trim() ||
          providerConfig.launchArgs.trim()
        )
          return false;
        if (
          provider.environment?.some(
            (entry) => entry.name.toUpperCase() === "CODEX_HOME" && typeof entry.value !== "string",
          )
        )
          return false;
        const env = yield* mergeProviderInstanceEnvironment(provider.environment, environment);
        const layout = yield* resolveCodexHomeLayout(
          !providerConfig.homePath.trim() && env.CODEX_HOME?.trim()
            ? { ...providerConfig, homePath: env.CODEX_HOME }
            : providerConfig,
        ).pipe(Effect.provideService(Path.Path, path));
        const key = yield* source;
        if (nativeId) {
          const store = yield* getStore;
          if (
            !(yield* Effect.try({
              try: () => store.isAdmitted(key.source, nativeId),
              catch: failure,
            }))
          )
            return false;
        }
        return (
          key.available &&
          desktopHistorySourceId(key.source) === sourceId &&
          normalizeProjectPathForComparison(yield* fs.realPath(layout.sharedHomePath)) ===
            key.source
        );
      },
      Effect.orElseSucceed(() => false),
    );
    return {
      isCurrentTitle: Effect.fn("DesktopHistoryLibrary.isCurrentTitle")(
        function* (read, requireHistoryAdmission) {
          if (
            !(yield* mayProject(read.sourceId, requireHistoryAdmission ? read.nativeId : undefined))
          )
            return false;
          const key = yield* source;
          const store = yield* getStore;
          return yield* Effect.try({
            try: () => store.isCurrentTitle(key.source, read),
            catch: failure,
          });
        },
        Effect.orElseSucceed(() => false),
      ),
      observeTitle: Effect.fn("DesktopHistoryLibrary.observeTitle")(
        function* (nativeId, sourceId, requireHistoryAdmission) {
          const changes = yield* settings.subscribeChanges;
          const lease = yield* acquireLease(desktopHome, sourceId);
          const admitted = requireHistoryAdmission
            ? mayProject(desktopHistorySourceId(lease.source.homePath), nativeId)
            : Effect.succeed(true);
          if (!(yield* admitted)) return null;
          if (!history.readTitle)
            return yield* failure(new Error("Native title reads are unavailable."));
          return yield* Effect.gen(function* () {
            const name = yield* history.readTitle!({
              providerInstanceId: instanceId,
              nativeThreadId: nativeId,
              source: lease.source,
            });
            if (!name) return null;
            return yield* Effect.gen(function* () {
              yield* lease.assertCurrent;
              if (!(yield* admitted)) return null;
              const store = yield* getStore;
              return yield* Effect.try({
                try: () => store.observeTitle(lease.source.homePath, nativeId, name),
                catch: failure,
              });
            }).pipe(publicationLock.withPermit);
          }).pipe(
            Effect.raceFirst(
              changes.pipe(
                Stream.filter(
                  (next) =>
                    stableStringify(next.providerInstances[instanceId]) !==
                    stableStringify(lease.source.provider),
                ),
                Stream.runHead,
                Effect.flatMap((next) =>
                  Option.isSome(next)
                    ? failure(new Error("The Share title source changed."))
                    : Effect.never,
                ),
              ),
            ),
          );
        },
        Effect.scoped,
        Effect.mapError(failure),
      ),
      refresh,
      mayProject,
      // Classification writes and event-store commits share this gate across both databases.
      withProjection: Effect.fn("DesktopHistoryLibrary.withProjection")(
        <A, E, R>(effect: Effect.Effect<A, E, R>) => publicationLock.withPermit(effect),
      ),
      state: Effect.gen(function* () {
        const key = yield* source;
        const store = yield* getStore;
        const syncAvailable = yield* mayProject(desktopHistorySourceId(key.source));
        return yield* Effect.try({
          try: () => ({
            entries: store.list(key.source),
            sourceAvailable: key.available,
            syncAvailable,
            detail: key.error,
            cache: store.statistics(key.source),
            discovery: store.discoveryStatus(key.source),
          }),
          catch: failure,
        });
      }),
      page: Effect.fn("DesktopHistoryLibrary.page")(function* (
        input: CodexDesktopHistoryPageInput,
      ) {
        const key = yield* source;
        const store = yield* getStore;
        return yield* Effect.try({
          try: () => desktopHistoryPage(store, key.source, input),
          catch: failure,
        });
      }),
      list: Effect.gen(function* () {
        const key = yield* source;
        const store = yield* getStore;
        return yield* Effect.try({ try: () => store.list(key.source), catch: failure });
      }),
      read: Effect.fn("DesktopHistoryLibrary.read")(function* (id: string, sourceId?: string) {
        const key = yield* source;
        const store = yield* getStore;
        if (sourceId !== undefined && desktopHistorySourceId(key.source) !== sourceId)
          return yield* failure(
            new Error(
              "The Desktop history source changed. Refresh the library before projecting history.",
            ),
          );
        return yield* Effect.try({ try: () => store.read(key.source, id), catch: failure });
      }),
    };
  }),
);
