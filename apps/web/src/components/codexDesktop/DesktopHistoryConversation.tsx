import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import type {
  EnvironmentId,
  ThreadId,
  CodexDesktopState,
  CodexDesktopHistoryLibraryState,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { codexDesktopEnvironment } from "../../state/codexDesktop";
import { useAtomCommand } from "../../state/use-atom-command";
import { DesktopSavedHistory } from "./DesktopSavedHistory";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

const emptyOwner = Atom.make(AsyncResult.success(null));

export function DesktopOwnerPermissions(props: { environmentId: EnvironmentId; nativeId: string }) {
  const result = useAtomValue(
    codexDesktopEnvironment.watch({
      environmentId: props.environmentId,
      input: { conversationId: props.nativeId },
    }),
  );
  const owner = Option.getOrNull(AsyncResult.value(result));
  const permissions =
    AsyncResult.isSuccess(result) && owner?.status === "ready" ? owner.permissions : undefined;
  const sandboxLabels: Record<string, string> = {
    dangerFullAccess: "Full access",
    readOnly: "Read-only",
    workspaceWrite: "Workspace write",
    externalSandbox: "External sandbox",
  };
  const approvalLabels: Record<string, string> = {
    never: "Never",
    untrusted: "Untrusted commands",
    "on-request": "On request",
    "on-failure": "On failure",
    custom: "Custom",
  };
  return (
    <div className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground" role="status">
      {permissions?.sandboxMode && permissions.approvalPolicy
        ? `Desktop permissions: ${sandboxLabels[permissions.sandboxMode] ?? "Custom sandbox"} · Approvals: ${approvalLabels[permissions.approvalPolicy] ?? "Custom"}.`
        : "Desktop permissions are currently unavailable."}{" "}
      Shared messages use Desktop permissions. Change them in Codex Desktop.
    </div>
  );
}

export function useDesktopHistoryConnection(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  nativeId?: string;
  sourceId?: string;
}) {
  const { environmentId, threadId, nativeId, sourceId } = props;
  const attach = useAtomCommand(codexDesktopEnvironment.attachExisting, { reportFailure: false });
  const allowed = useAtomValue(
    codexDesktopEnvironment.attachExisting.permissionAtom(environmentId),
  );
  const result = useAtomValue<AsyncResult.AsyncResult<CodexDesktopState | null, unknown>>(
    nativeId
      ? codexDesktopEnvironment.watch({ environmentId, input: { conversationId: nativeId } })
      : emptyOwner,
  );
  const libraryResult = useAtomValue<
    AsyncResult.AsyncResult<CodexDesktopHistoryLibraryState | null, unknown>
  >(
    nativeId
      ? codexDesktopEnvironment.historyLibrary({ environmentId, input: undefined })
      : emptyOwner,
  );
  const library = Option.getOrNull(AsyncResult.value(libraryResult));
  const sourceReady =
    library?.syncAvailable === true &&
    library.entries.some(
      (entry) => entry.sourceId === sourceId && entry.conversationId === nativeId,
    );
  const owner = Option.getOrNull(AsyncResult.value(result));
  const identity = `${environmentId}:${threadId}:${sourceId}:${nativeId}`;
  const [connection, setConnection] = useState({ identity: "", connected: false, error: "" });
  const pending = useRef<{ identity: string; generation: number } | null>(null);
  const generation = useRef(0);
  const attemptedIdentity = useRef<string | null>(null);
  const activeIdentity = useRef(identity);
  const mounted = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns acknowledgements for the external IPC binding; StrictMode replay retains the same in-flight connection, navigation invalidates it.
  useEffect(() => {
    mounted.current = true;
    if (activeIdentity.current !== identity) {
      activeIdentity.current = identity;
      generation.current++;
      pending.current = null;
    }
    return () => {
      mounted.current = false;
    };
  }, [identity]);
  const connect = async () => {
    if (!nativeId || !allowed || !sourceReady || pending.current?.identity === identity) return;
    const request = ++generation.current;
    pending.current = { identity, generation: request };
    try {
      const bound = await attach({ environmentId, input: { threadId, conversationId: nativeId } });
      if (bound._tag !== "Success") throw squashAtomCommandFailure(bound);
      if (mounted.current && generation.current === request)
        setConnection({ identity, connected: true, error: "" });
    } catch (cause) {
      if (mounted.current && generation.current === request)
        setConnection({
          identity,
          connected: false,
          error: cause instanceof Error ? cause.message : "Desktop is unavailable.",
        });
    } finally {
      if (pending.current?.generation === request) pending.current = null;
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Establishes the external IPC binding for the visible chat; state is updated by its async acknowledgement.
  useEffect(() => {
    if (!nativeId || !allowed || !sourceReady || attemptedIdentity.current === identity) return;
    attemptedIdentity.current = identity;
    void connect();
  }, [identity, nativeId, allowed, sourceReady, connect]);
  return {
    ready:
      sourceReady &&
      connection.identity === identity &&
      connection.connected &&
      owner?.status === "ready",
    error: connection.identity === identity ? connection.error : "",
    allowed: allowed && sourceReady,
    connect,
  };
}

export function DesktopHistoryConversation(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  nativeId: string;
  sourceId: string;
  connection: ReturnType<typeof useDesktopHistoryConnection>;
}) {
  const { ready, error, allowed, connect } = props.connection;
  const [open, setOpen] = useState(false);
  return (
    <div className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span role="status">
          {ready
            ? "Connected to Codex Desktop"
            : "Saved history · open this conversation in Desktop to send"}
        </span>
        {!ready ? (
          <Button size="sm" variant="ghost" disabled={!allowed} onClick={() => void connect()}>
            Reconnect
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Complete saved history
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Saved Codex history</DialogTitle>
            <DialogDescription>
              Full saved item content, including tool records and attachments.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex max-h-[70vh] min-h-0 flex-col">
            {open ? (
              <DesktopSavedHistory
                key={`${props.environmentId}:${props.sourceId}:${props.nativeId}`}
                environmentId={props.environmentId}
                conversationId={props.nativeId}
                sourceId={props.sourceId}
              />
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
