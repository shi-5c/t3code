import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { DesktopConversationPicker } from "./DesktopConversationPicker";
import { DesktopSavedHistory } from "./DesktopSavedHistory";
import { useSearch } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { codexDesktopHostAtom } from "../../state/codexDesktop";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { EnvironmentId } from "@t3tools/contracts";

export function CodexDesktopPage() {
  const { conversationId, sourceId, historyEnvironmentId } = useSearch({
    from: "/_chat/codex-desktop",
  });
  const selected = useAtomValue(codexDesktopHostAtom);
  const primary = usePrimaryEnvironmentId();
  const environmentId = historyEnvironmentId
    ? EnvironmentId.make(historyEnvironmentId)
    : (selected ?? primary);
  return (
    <SidebarInset className="h-dvh min-w-0 overflow-hidden">
      <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 border-b px-3">
        <SidebarTrigger />
        <h1 className="truncate text-sm font-medium">
          {sourceId ? "Saved Codex history" : "Connect a Codex Desktop conversation"}
        </h1>
      </header>
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col p-4">
        {conversationId && environmentId && sourceId ? (
          <DesktopSavedHistory
            key={`${environmentId}:${sourceId}:${conversationId}`}
            environmentId={environmentId}
            conversationId={conversationId}
            sourceId={sourceId}
          />
        ) : (
          <DesktopConversationPicker />
        )}
      </div>
    </SidebarInset>
  );
}
