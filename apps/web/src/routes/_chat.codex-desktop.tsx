import { createFileRoute } from "@tanstack/react-router";
import { CodexDesktopPage } from "../components/codexDesktop/CodexDesktopPage";

export const Route = createFileRoute("/_chat/codex-desktop")({
  validateSearch: (raw: Record<string, unknown>) => ({
    historyEnvironmentId:
      typeof raw.historyEnvironmentId === "string" && raw.historyEnvironmentId.length <= 150
        ? raw.historyEnvironmentId
        : undefined,
    sourceId:
      typeof raw.sourceId === "string" && /^[a-f0-9]{64}$/.test(raw.sourceId)
        ? raw.sourceId
        : undefined,
    conversationId:
      typeof raw.conversationId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(raw.conversationId)
        ? raw.conversationId
        : undefined,
  }),
  component: CodexDesktopPage,
});
