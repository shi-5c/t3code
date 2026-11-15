import { useNavigate } from "@tanstack/react-router";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { ThreadTypeSelect } from "../ThreadTypeSelect";
import { InlineButton } from "../ui/button";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { codexDesktopHostAtom } from "../../state/codexDesktop";
import { codexDesktopEnvironment } from "../../state/codexDesktop";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";

export function DraftThreadType({
  draftId,
  showEnable = false,
}: {
  draftId: DraftId | null;
  showEnable?: boolean;
}) {
  const environmentId = useComposerDraftStore((s) =>
    draftId ? s.getDraftSession(draftId)?.environmentId : undefined,
  );
  const threadType = useComposerDraftStore((s) =>
    draftId ? (s.getDraftSession(draftId)?.threadType ?? "t3") : "t3",
  );
  const navigate = useNavigate();
  if (!draftId) return null;
  return (
    <div className="mt-3 flex flex-col items-center gap-2 text-xs text-muted-foreground">
      <ThreadTypeSelect
        value={threadType}
        onChange={(value) =>
          useComposerDraftStore.getState().setDraftThreadContext(draftId, { threadType: value })
        }
      />
      {threadType === "codex-shared" && showEnable && environmentId ? (
        <EnableSharedProvider environmentId={environmentId} />
      ) : null}
      {threadType === "codex-shared" ? (
        <p>
          Select Codex Desktop Share to create a shared conversation, or open an existing Desktop
          conversation and{" "}
          <InlineButton
            onClick={() => {
              const draft = useComposerDraftStore.getState().getDraftSession(draftId);
              if (!draft) return;
              appAtomRegistry.set(codexDesktopHostAtom, draft.environmentId);
              void navigate({
                to: "/codex-desktop",
                search: {
                  conversationId: undefined,
                  sourceId: undefined,
                  historyEnvironmentId: undefined,
                },
              });
            }}
          >
            connect it to T3
          </InlineButton>
          .
        </p>
      ) : (
        <p>T3 manages this conversation. Codex may also list its saved history.</p>
      )}
    </div>
  );
}

function EnableSharedProvider({ environmentId }: { environmentId: EnvironmentId }) {
  const canEnable = useAtomValue(codexDesktopEnvironment.enable.permissionAtom(environmentId));
  const enable = useAtomCommand(codexDesktopEnvironment.enable, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const prepare = async () => {
    if (busy || !canEnable) return;
    setBusy(true);
    try {
      const result = await enable({ environmentId, input: undefined });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not enable Codex Desktop Share.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="status">
      {canEnable ? (
        <InlineButton disabled={busy} onClick={() => void prepare()}>
          {busy ? "Enabling…" : "Enable Codex Desktop Share"}
        </InlineButton>
      ) : (
        <span>Ask the host to enable Codex Desktop Share.</span>
      )}
      {error ? (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
