import {
  threadTypeOf,
  type ThreadType,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { DESKTOP_INSTANCE_ID } from "./identity.ts";

export function threadCreationUnavailableReason(
  threadType: ThreadType,
  instanceId: string,
  driver?: string,
  available?: boolean,
) {
  if (instanceId === DESKTOP_INSTANCE_ID && threadType !== "codex-shared") {
    return "Select Codex shared to create a conversation with Codex Desktop Share.";
  }
  if (threadType === "codex-shared") {
    if (instanceId !== DESKTOP_INSTANCE_ID || driver !== "codex")
      return "New shared conversations require Codex Desktop Share. Other providers cannot create them.";
    if (available !== true)
      return "Codex Desktop Share is disabled or unavailable. Enable it and resolve its status before creating a shared conversation.";
  }
  return null;
}

/** Preserve old records and identities, while admitting execution only through the fixed Share provider. */
export function sharedNativeBindingUnavailableReason(
  thread: Pick<
    OrchestrationV2AppThread,
    "id" | "threadType" | "providerInstanceId" | "activeProviderThreadId"
  >,
  providerThreads: ReadonlyArray<
    Pick<
      OrchestrationV2ProviderThread,
      "id" | "appThreadId" | "providerInstanceId" | "driver" | "nativeThreadRef" | "nativeMetadata"
    >
  >,
  requestedInstanceId: string,
) {
  if (threadTypeOf(thread) !== "codex-shared") return null;
  if (providerThreads.some((row) => row.nativeMetadata?.codexSharedCreationPending))
    return "The shared creation result is unknown. Resolve the original native identity before sending; do not switch providers or create again.";
  if (requestedInstanceId !== thread.providerInstanceId)
    return "Shared conversations keep their original provider. Use the explicit Desktop handoff to change ownership.";
  if (thread.providerInstanceId !== DESKTOP_INSTANCE_ID)
    return "This development shared conversation is read-only. Its history and native identity are preserved. Use Codex Desktop Share for supported shared conversations.";
  const owner = providerThreads.find((row) => row.id === thread.activeProviderThreadId);
  if (
    owner &&
    (owner.appThreadId !== thread.id ||
      owner.providerInstanceId !== thread.providerInstanceId ||
      owner.driver !== "codex")
  )
    return "The saved shared binding is inconsistent. Reconcile its original native identity before sending.";
  if (owner?.nativeThreadRef?.nativeId) {
    if (
      owner.appThreadId !== thread.id ||
      owner.providerInstanceId !== thread.providerInstanceId ||
      owner.driver !== "codex" ||
      owner.nativeThreadRef.driver !== "codex" ||
      owner.nativeThreadRef.strength !== "strong"
    )
      return "The saved shared binding is inconsistent. Reconcile its original native identity before sending.";
    return null;
  }
  if (providerThreads.some((row) => row.nativeThreadRef?.nativeId))
    return "The saved shared identity is not the active binding. Reconcile it before sending; no replacement will be created.";
  if (requestedInstanceId !== DESKTOP_INSTANCE_ID)
    return "This shared draft has no confirmed native binding. Create a new conversation with Codex Desktop Share; the old draft is kept.";
  return null;
}
