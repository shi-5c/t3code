import { createCodexDesktopEnvironmentAtoms } from "@t3tools/client-runtime/state/codex-desktop";
import { connectionAtomRuntime } from "../connection/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

export const codexDesktopEnvironment = createCodexDesktopEnvironmentAtoms(connectionAtomRuntime);
export const codexDesktopHostAtom = Atom.make<EnvironmentId | null>(null).pipe(Atom.keepAlive);
export const codexDesktopReturnHrefAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);
