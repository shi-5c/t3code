import { describe, expect, it } from "vite-plus/test";
import {
  ThreadId,
  ProviderThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import {
  threadCreationUnavailableReason,
  sharedNativeBindingUnavailableReason,
} from "./threadCreation.ts";
describe("shared creation admission", () => {
  it.each(["codex", "codex-other-home", "managed-shadow", "unknown-account"])(
    "rejects a new shared thread through %s even when it is Codex and available",
    (id) => {
      expect(threadCreationUnavailableReason("codex-shared", id, "codex", true)).toContain(
        "Codex Desktop Share",
      );
    },
  );
  it("requires a ready reserved provider and leaves ordinary T3 creation unchanged", () => {
    expect(
      threadCreationUnavailableReason("codex-shared", "codex-desktop", "codex", true),
    ).toBeNull();
    for (const available of [false, undefined])
      expect(
        threadCreationUnavailableReason("codex-shared", "codex-desktop", "codex", available),
      ).toContain("unavailable");
    expect(threadCreationUnavailableReason("t3", "codex", "codex", false)).toBeNull();
    expect(threadCreationUnavailableReason("t3", "codex-desktop", "codex", true)).not.toBeNull();
  });
  it("keeps development bindings read-only and protects the fixed provider's native identity", () => {
    const instanceId = ProviderInstanceId.make("codex-desktop");
    const thread = {
      id: ThreadId.make("old"),
      threadType: "codex-shared" as const,
      providerInstanceId: instanceId,
      activeProviderThreadId: ProviderThreadId.make("owner"),
    };
    const owner = {
      id: thread.activeProviderThreadId,
      appThreadId: thread.id,
      providerInstanceId: instanceId,
      driver: ProviderDriverKind.make("codex"),
      nativeThreadRef: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "original",
        strength: "strong" as const,
      },
    };
    expect(sharedNativeBindingUnavailableReason(thread, [owner], instanceId)).toBeNull();
    expect(
      sharedNativeBindingUnavailableReason(
        { ...thread, providerInstanceId: ProviderInstanceId.make("legacy-codex") },
        [{ ...owner, providerInstanceId: ProviderInstanceId.make("legacy-codex") }],
        "legacy-codex",
      ),
    ).toContain("read-only");
    expect(sharedNativeBindingUnavailableReason(thread, [owner], "legacy-codex")).toContain(
      "original provider",
    );
    expect(
      sharedNativeBindingUnavailableReason(
        thread,
        [{ ...owner, nativeThreadRef: null }],
        instanceId,
      ),
    ).toBeNull();
    expect(
      sharedNativeBindingUnavailableReason(
        thread,
        [{ ...owner, nativeThreadRef: null, nativeMetadata: { codexSharedCreationPending: true } }],
        "codex-desktop",
      ),
    ).toContain("unknown");
    expect(
      sharedNativeBindingUnavailableReason(
        thread,
        [{ ...owner, appThreadId: ThreadId.make("other") }],
        instanceId,
      ),
    ).toContain("inconsistent");
    expect(
      sharedNativeBindingUnavailableReason(
        { ...thread, activeProviderThreadId: null },
        [owner],
        instanceId,
      ),
    ).toContain("not the active");
    expect(
      sharedNativeBindingUnavailableReason(
        { ...thread, providerInstanceId: ProviderInstanceId.make("codex-desktop") },
        [],
        "codex-desktop",
      ),
    ).toBeNull();
  });
});
