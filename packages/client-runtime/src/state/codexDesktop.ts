import { WS_METHODS, type CodexDesktopState } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { mergeDesktopUpdate } from "./codexDesktopUpdates.ts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createCodexDesktopEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    enable: createEnvironmentRpcCommand(runtime, {
      label: "codex-desktop:enable",
      tag: WS_METHODS.codexDesktopEnable,
    }),
    bind: createEnvironmentRpcCommand(runtime, {
      label: "codex-desktop:bind",
      tag: WS_METHODS.codexDesktopBind,
    }),
    attachExisting: createEnvironmentRpcCommand(runtime, {
      label: "codex-desktop:attach-existing",
      tag: WS_METHODS.codexDesktopAttachExisting,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "codex-desktop:list",
      tag: WS_METHODS.codexDesktopList,
    }),
    preview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "codex-desktop:preview",
      tag: WS_METHODS.codexDesktopPreview,
    }),
    historyLibrary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "codex-desktop:history-library",
      tag: WS_METHODS.codexDesktopHistoryLibrary,
    }),
    historyPage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "codex-desktop:history-page",
      tag: WS_METHODS.codexDesktopHistoryPage,
    }),
    watch: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "codex-desktop:watch",
      tag: WS_METHODS.codexDesktopWatch,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(
          Stream.mapAccum(
            () => null as CodexDesktopState | null,
            (previous, update) => {
              const next = mergeDesktopUpdate(previous, update);
              return [next, [next]] as const;
            },
          ),
        ),
    }),
    send: createEnvironmentRpcCommand(runtime, {
      label: "codex-desktop:send",
      tag: WS_METHODS.codexDesktopSend,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "codex-desktop:stop",
      tag: WS_METHODS.codexDesktopStop,
    }),
  };
}
