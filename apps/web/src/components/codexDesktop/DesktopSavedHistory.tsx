import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { type EnvironmentId, type CodexDesktopHistoryPageInput } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { codexDesktopEnvironment, codexDesktopHostAtom } from "../../state/codexDesktop";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironments } from "../../state/environments";
import { useQuietThreadShells } from "../../state/entities";
import { Button } from "../ui/button";
import { useRetainedValue } from "../Sidebar.logic";
import { useSidebar } from "../ui/sidebar";

export function DesktopHistorySidebar({ query }: { query: string }) {
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <DesktopHistoryHost
      key={environment.environmentId}
      environmentId={environment.environmentId}
      label={environment.label}
      query={query}
    />
  ));
}

function DesktopHistoryHost(props: { environmentId: EnvironmentId; label: string; query: string }) {
  const atom = codexDesktopEnvironment.historyLibrary({
    environmentId: props.environmentId,
    input: undefined,
  });
  const result = useAtomValue(atom);
  const state = Option.getOrNull(AsyncResult.value(result));
  const threads = useQuietThreadShells();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [archived, setArchived] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refreshes the external history cache while its sidebar host is mounted.
  useEffect(() => {
    const timer = setInterval(() => appAtomRegistry.refresh(atom), 15_000);
    return () => clearInterval(timer);
  }, [atom]);
  if (!state?.entries.length) return null;
  const represented = new Set(
    threads
      .filter(
        (thread) => thread.environmentId === props.environmentId && thread.codexDesktopHistory,
      )
      .map(
        (thread) =>
          `${thread.codexDesktopHistory!.sourceId}:${thread.codexDesktopHistory!.nativeId}`,
      ),
  );
  const query = props.query.trim().toLowerCase();
  const rows = state.entries.filter(
    (entry) =>
      !represented.has(`${entry.sourceId}:${entry.conversationId}`) &&
      (archived || !entry.archived) &&
      (!query ||
        `${entry.title} ${entry.cwd} ${entry.conversationId}`.toLowerCase().includes(query)),
  );
  const cached = state.entries.filter((entry) => entry.fetchedAt !== null).length;
  return (
    <section className="border-t px-2 py-3" aria-label={`Codex saved history on ${props.label}`}>
      <details open={Boolean(query)}>
        <summary className="cursor-pointer text-xs font-medium">
          Codex history · {cached}/{state.entries.length}
        </summary>
        <p className="py-1 text-xs text-muted-foreground">
          {props.label} · Saved chats remain readable while Desktop is offline.
        </p>
        {state.cache ? (
          <p className="text-xs text-muted-foreground">
            {(state.cache.databaseBytes / 1048576).toFixed(1)} MB cache ·{" "}
            {state.cache.sourceVersions} retained versions
          </p>
        ) : null}
        {state.detail ? (
          <p role="status" className="text-xs text-muted-foreground">
            {state.detail}
          </p>
        ) : null}
        {state.discovery.some((source) => source.error) ? (
          <p role="status" className="text-xs text-muted-foreground">
            Some discovery sources are unavailable. Known chats continue syncing.
          </p>
        ) : null}
        <label className="my-2 flex gap-2 text-xs">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => setArchived(event.target.checked)}
          />
          Include archived
        </label>
        {rows.map((entry) => (
          <button
            key={`${entry.sourceId}:${entry.conversationId}`}
            type="button"
            className={`block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent ${entry.attachedToThreadId ? "pl-5" : ""}`}
            onClick={() => {
              appAtomRegistry.set(codexDesktopHostAtom, props.environmentId);
              if (isMobile) setOpenMobile(false);
              void navigate({
                to: "/codex-desktop",
                search: {
                  conversationId: entry.conversationId,
                  sourceId: entry.sourceId,
                  historyEnvironmentId: props.environmentId,
                },
              });
            }}
          >
            <span className="block truncate">
              {entry.attachedToThreadId ? "↳ " : ""}
              {entry.title}
            </span>
            <span className="text-2xs text-muted-foreground">
              {entry.membership.kind === "none"
                ? "No project"
                : entry.membership.kind === "assigned"
                  ? entry.membership.projectTitle || entry.membership.projectId
                  : "Project unknown"}{" "}
              · {entry.status}
            </span>
          </button>
        ))}
      </details>
    </section>
  );
}

export function DesktopSavedHistory(props: {
  environmentId: EnvironmentId;
  conversationId: string;
  sourceId: string;
}) {
  const [cursors, setCursors] = useState<Array<CodexDesktopHistoryPageInput["cursor"]>>([
    undefined,
  ]);
  const input = {
    conversationId: props.conversationId,
    sourceId: props.sourceId,
    cursor: cursors.at(-1),
  };
  const atom = codexDesktopEnvironment.historyPage({ environmentId: props.environmentId, input });
  const result = useAtomValue(atom);
  const currentPage = Option.getOrNull(AsyncResult.value(result));
  const page = useRetainedValue(
    `${props.environmentId}:${props.sourceId}:${props.conversationId}`,
    currentPage,
  );
  const library = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(
        codexDesktopEnvironment.historyLibrary({
          environmentId: props.environmentId,
          input: undefined,
        }),
      ),
    ),
  );
  const entry = library?.entries.find(
    (value) => value.conversationId === props.conversationId && value.sourceId === props.sourceId,
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {entry?.title || "Saved Codex history"}
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setCursors([undefined]);
            appAtomRegistry.refresh(
              codexDesktopEnvironment.historyPage({
                environmentId: props.environmentId,
                input: { conversationId: props.conversationId, sourceId: props.sourceId },
              }),
            );
          }}
        >
          Latest saved version
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Saved history is read-only. Open the original conversation in Desktop to connect its live
        execution.
      </p>
      {entry?.attachedToThreadId ? (
        <p className="text-xs text-muted-foreground">Attached to {entry.attachedToThreadId}</p>
      ) : null}
      {entry?.error ? (
        <p role="status" className="text-xs text-muted-foreground">
          {entry.error} Previously saved history is kept.
        </p>
      ) : null}
      {AsyncResult.isFailure(result) ? (
        <p role="alert" className="text-sm text-error">
          This history page could not be loaded. The last loaded page is still displayed. Return to
          the previous page or open the latest saved version.
        </p>
      ) : null}
      {result.waiting ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading saved page…
        </p>
      ) : null}
      {page?.thread === null ? (
        <p role="status" className="text-sm">
          Complete history has not been cached yet. Its sync status is {entry?.status ?? "pending"}.
        </p>
      ) : null}
      {page?.entries.map((record, index) => {
        const item = record.item;
        const text =
          typeof item?.text === "string"
            ? item.text
            : item?.type === "userMessage" && Array.isArray(item.content)
              ? item.content
                  .flatMap((part) =>
                    typeof part === "object" &&
                    part !== null &&
                    "text" in part &&
                    typeof part.text === "string"
                      ? [part.text]
                      : [],
                  )
                  .join("\n")
              : null;
        return (
          <article
            key={`${String(record.turn.id)}:${String(item?.id ?? index)}`}
            className="rounded border p-3"
          >
            <div className="mb-2 text-xs text-muted-foreground">
              {String(item?.type ?? "Empty turn")}
            </div>
            {text ? <div className="whitespace-pre-wrap break-words text-sm">{text}</div> : null}
            <details open={!text}>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Saved details
              </summary>
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(record, null, 2)}
              </pre>
            </details>
          </article>
        );
      })}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={cursors.length === 1}
          onClick={() => setCursors((values) => values.slice(0, -1))}
        >
          Previous
        </Button>
        <span className="text-xs text-muted-foreground">
          Page {cursors.length} · {page?.totalItems ?? 0} saved items
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!currentPage?.nextCursor || result.waiting || AsyncResult.isFailure(result)}
          onClick={() => {
            if (page?.nextCursor) setCursors((values) => [...values, page.nextCursor!]);
          }}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
