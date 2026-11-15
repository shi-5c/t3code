/** Reserved provider instance; it must never fall through to an independent CLI writer. */
import { CODEX_SHARED_INSTANCE_ID } from "@t3tools/contracts";
export const DESKTOP_INSTANCE_ID = CODEX_SHARED_INSTANCE_ID;

export function desktopInstanceSwitchRefusal(current: string, target: string): string | null {
  return current !== target && (current === DESKTOP_INSTANCE_ID || target === DESKTOP_INSTANCE_ID)
    ? "A shared Desktop conversation cannot move to or from an independent writer. Use Connect a Codex Desktop conversation."
    : null;
}
