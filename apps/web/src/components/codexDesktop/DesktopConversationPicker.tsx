import { DesktopHistoryPreview } from "./DesktopHistoryPreview";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  EnvironmentId,
  type CodexDesktopBinding,
  type CodexDesktopListInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { codexDesktopEnvironment, codexDesktopHostAtom } from "../../state/codexDesktop";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";

export function DesktopConversationPicker() {
  const primary = usePrimaryEnvironmentId();
  const selected = useAtomValue(codexDesktopHostAtom);
  const { environments } = useEnvironments();
  const target = useThreadRouteTarget();
  const navigate = useNavigate();
  const routeEnvironment =
    target?.kind === "server" && target.threadRef.threadId.startsWith("codex-desktop:")
      ? target.threadRef.environmentId
      : null;
  const environmentId = routeEnvironment ?? selected ?? primary;
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarGroup>
          <label className="text-xs text-muted-foreground" htmlFor="desktop-host">
            Codex Desktop host
          </label>
          <select
            id="desktop-host"
            className="mt-2 w-full rounded border bg-background p-2 text-sm"
            value={environmentId ?? ""}
            onChange={(event) => {
              appAtomRegistry.set(codexDesktopHostAtom, EnvironmentId.make(event.target.value));
              if (routeEnvironment)
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
            {environments.map((environment) => (
              <option key={environment.environmentId} value={environment.environmentId}>
                {environment.label}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-muted-foreground">
            Execution permissions are controlled in Codex Desktop.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Model choices come from this host's Codex installation and may differ from Desktop.
          </p>
        </SidebarGroup>
        {environmentId ? (
          <DesktopSessionList key={environmentId} environmentId={environmentId} />
        ) : (
          <p className="p-3 text-sm">Connect to a host to view its conversations.</p>
        )}
      </div>
    </>
  );
}

function DesktopSessionList({ environmentId }: { environmentId: EnvironmentId }) {
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [archived, setArchived] = useState<"active" | "archived" | "all">("active");
  const [cursors, setCursors] = useState<Array<CodexDesktopListInput["cursor"]>>([undefined]);
  const input = { query: searchQuery, archived, cursor: cursors.at(-1) };
  const result = useAtomValue(codexDesktopEnvironment.list({ environmentId, input }));
  const data = Option.getOrNull(AsyncResult.value(result));
  const search = useSearch({ strict: false });
  const target = useThreadRouteTarget();
  const conversationId =
    target?.kind === "server" && target.threadRef.threadId.startsWith("codex-desktop:")
      ? target.threadRef.threadId.slice("codex-desktop:".length)
      : search.conversationId;
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [manualId, setManualId] = useState("");
  const [preview, setPreview] = useState<{
    environmentId: EnvironmentId;
    conversationId: string;
    sourceId: string | null;
  } | null>(null);
  const libraryResult = useAtomValue(
    codexDesktopEnvironment.historyLibrary({ environmentId, input: undefined }),
  );
  const library = Option.getOrNull(AsyncResult.value(libraryResult));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState<CodexDesktopBinding["uncertain"]>([]);
  const enable = useAtomCommand(codexDesktopEnvironment.enable, { reportFailure: false });
  const bind = useAtomCommand(codexDesktopEnvironment.bind, { reportFailure: false });
  const canEnable = useAtomValue(codexDesktopEnvironment.enable.permissionAtom(environmentId));
  const canBind = useAtomValue(codexDesktopEnvironment.bind.permissionAtom(environmentId));
  const open = async (id: string, dismissUnsentAttemptId?: string) => {
    if (busy || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) return;
    if (!canBind) {
      setError("This connection cannot bind conversations. Ask the host to enable shared access.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (canEnable) {
        const enabled = await enable({ environmentId, input: undefined });
        if (enabled._tag !== "Success") throw squashAtomCommandFailure(enabled);
      }
      const bound = await bind({
        environmentId,
        input: {
          conversationId: id,
          ...(dismissUnsentAttemptId ? { dismissUnsentAttemptId } : {}),
        },
      });
      if (bound._tag !== "Success") throw squashAtomCommandFailure(bound);
      setUncertain(bound.value.uncertain);
      if (isMobile) setOpenMobile(false);
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: bound.value.threadId },
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not open the shared conversation. Check the host connection.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <SidebarGroup>
      <div className="mb-2 flex items-center gap-2">
        <input
          aria-label="Search Codex conversations"
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              setSearchQuery(query.trim());
              setCursors([undefined]);
            }
          }}
          placeholder="Search conversations"
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            appAtomRegistry.refresh(
              codexDesktopEnvironment.list({
                environmentId,
                input: { query: query.trim(), archived },
              }),
            );
            setSearchQuery(query.trim());
            setCursors([undefined]);
          }}
        >
          Search / refresh
        </Button>
      </div>
      <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        History
        <select
          aria-label="Archived conversation filter"
          className="rounded border bg-background p-1"
          value={archived}
          onChange={(event) => {
            setArchived(event.target.value as "active" | "archived" | "all");
            setCursors([undefined]);
          }}
        >
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </select>
      </label>
      <p className="mb-2 text-xs text-muted-foreground">
        All dates and Desktop project assignments. Connecting uses the existing workspace in T3; it
        does not move the Desktop conversation.
      </p>
      <p className="mb-2 text-xs text-muted-foreground">{data?.detail}</p>
      {AsyncResult.isFailure(result) ? (
        <p role="alert" className="p-2 text-sm text-error">
          Could not list conversations. Check the host connection.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="p-2 text-sm text-error">
          {error}
        </p>
      ) : null}
      {uncertain.map((value) => (
        <div role="alert" key={value.attemptId} className="p-2 text-xs text-error">
          A send has an unknown result. New turn identities are waiting for review. Check Desktop
          before sending again.
          {value.candidateId ? (
            <p>One turn is waiting for identity reconciliation: {value.candidateId}</p>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !conversationId}
            onClick={() => {
              if (conversationId) void open(conversationId, value.attemptId);
            }}
          >
            I checked Desktop: this input was not sent
          </Button>
        </div>
      ))}
      {busy ? (
        <p role="status" className="p-2 text-xs text-muted-foreground">
          Opening shared conversation…
        </p>
      ) : null}
      <SidebarMenu aria-label="Codex Desktop conversations">
        {data?.conversations.map((item) => (
          <SidebarMenuItem key={item.conversationId}>
            <SidebarMenuButton
              isActive={item.conversationId === conversationId}
              disabled={busy || item.archived || !item.cwd}
              onClick={() => open(item.conversationId)}
              title={`${item.cwd || "No workspace"}\n${item.conversationId}`}
            >
              <span className="truncate">
                {item.title.split(/\r?\n/)[0]?.slice(0, 120) || item.conversationId}
              </span>
            </SidebarMenuButton>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setPreview({
                  environmentId,
                  conversationId: item.conversationId,
                  sourceId:
                    library?.entries.find((entry) => entry.conversationId === item.conversationId)
                      ?.sourceId ?? null,
                })
              }
            >
              Complete saved history
            </Button>
            {item.archived || !item.cwd ? (
              <p className="px-2 text-xs text-muted-foreground">
                {item.archived
                  ? "Archived · restore in Desktop before connecting."
                  : "No workspace · listed without creating a T3 project."}
              </p>
            ) : null}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
      <div className="mt-2 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={cursors.length === 1 || result.waiting}
          onClick={() => setCursors((value) => value.slice(0, -1))}
        >
          Previous
        </Button>
        <span className="text-xs text-muted-foreground">Page {cursors.length}</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={!data?.nextCursor || result.waiting}
          onClick={() => {
            if (data?.nextCursor) setCursors((value) => [...value, data.nextCursor!]);
          }}
        >
          Next
        </Button>
      </div>
      {data?.conversations.length === 0 ? (
        <p className="p-2 text-sm text-muted-foreground">{data.detail}</p>
      ) : null}
      <details className="mt-3 text-xs text-muted-foreground">
        <summary>Open by ID</summary>
        <form
          className="mt-2 flex gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            open(manualId.trim());
          }}
        >
          <input
            aria-label="Conversation ID"
            className="min-w-0 flex-1 rounded border bg-background p-2"
            value={manualId}
            onChange={(event) => setManualId(event.target.value)}
            maxLength={100}
          />
          <Button type="submit" size="sm">
            Open
          </Button>
        </form>
      </details>
      {preview ? <DesktopHistoryPreview {...preview} onClose={() => setPreview(null)} /> : null}
    </SidebarGroup>
  );
}
