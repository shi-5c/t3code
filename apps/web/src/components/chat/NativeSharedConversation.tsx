import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  CodexSettings,
  nativeTitleHandoffState,
  type CodexTitleSync,
  type ProviderInstanceConfig,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type OrchestrationV2ProviderThreadNativeMetadata,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { agentSessionImport } from "../../state/agentSessions";
import { codexDesktopEnvironment } from "../../state/codexDesktop";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { ensureLocalApi } from "../../localApi";
import { InlineButton } from "../ui/button";
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

export function NativeSharedConversation(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  nativeId: string | null;
  creationUnknown: boolean;
  title: string;
  titleVersion: number;
  titleSource?: CodexTitleSync["source"] | undefined;
  titlePreparation: OrchestrationV2ProviderThreadNativeMetadata["codexNativeTitle"];
  busy: boolean;
  canOpenLocally: boolean;
  provider: ProviderInstanceConfig | undefined;
  desktopShare?: boolean;
  releaseState: "held" | "pending" | "ready" | "unknown" | undefined;
}) {
  const canSync = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const canConnect = useAtomValue(
    codexDesktopEnvironment.attachExisting.permissionAtom(props.environmentId),
  );
  const importHistory = useAtomCommand(agentSessionImport, { reportFailure: false });
  const attachExisting = useAtomCommand(codexDesktopEnvironment.attachExisting, {
    reportFailure: false,
  });
  const inFlight = useRef(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const connect = async () => {
    if (
      inFlight.current ||
      !canConnect ||
      props.busy ||
      props.releaseState !== "ready" ||
      titleBlocksHandoff ||
      !props.nativeId
    )
      return;
    inFlight.current = true;
    setConnecting(true);
    try {
      const result = await attachExisting({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, conversationId: props.nativeId },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Desktop could not be connected. Open this conversation there, then retry.",
      );
    } finally {
      inFlight.current = false;
      setConnecting(false);
    }
  };
  const refresh = async (reconcileRelease = false) => {
    if (inFlight.current || !canSync || props.busy || !props.nativeId) return;
    inFlight.current = true;
    setSyncing(true);
    try {
      const result = await importHistory({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          threadId: props.threadId,
          ...(reconcileRelease ? { reconcileRelease: true } : {}),
        },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Saved history could not be refreshed.");
    } finally {
      inFlight.current = false;
      setSyncing(false);
    }
  };
  const config = decodeCodexSettings(props.provider?.config ?? {});
  const defaultHome =
    props.desktopShare ||
    (config._tag === "Some" &&
      config.value.homePath === "" &&
      !props.provider?.environment?.some(
        (variable) => variable.name.toUpperCase() === "CODEX_HOME",
      ));
  const titleSaved =
    props.titlePreparation?.status === "saved" &&
    props.titlePreparation.desiredTitle === props.title &&
    props.titlePreparation.version === props.titleVersion;
  const titleBlocksHandoff =
    nativeTitleHandoffState({
      title: props.title,
      titleVersion: props.titleVersion,
      titleSource: props.titleSource,
      preparation: props.titlePreparation,
    }) !== "ready";
  const titleObserved = props.titleSource === "saved" && !titleBlocksHandoff;
  const ready = props.releaseState === "ready" && !props.busy && defaultHome && !titleBlocksHandoff;
  const open = async () => {
    if (opening || !ready || !props.nativeId || !props.canOpenLocally) return;
    setOpening(true);
    try {
      await ensureLocalApi().shell.openExternal(
        `codex://threads/${encodeURIComponent(props.nativeId)}`,
      );
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Codex Desktop could not be opened. The conversation is saved here.",
      );
    } finally {
      setOpening(false);
    }
  };
  return (
    <div className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground" role="status">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          {props.creationUnknown
            ? "Creation result unknown. Find it in Codex, then connect that existing conversation. Archive this empty placeholder after reconnecting; do not resend the first message."
            : !props.nativeId
              ? props.desktopShare
                ? "The first message creates this shared conversation."
                : "This draft has no native binding. Create a new conversation with Codex Desktop Share; this draft is kept."
              : props.busy
                ? "T3 is using this shared conversation."
                : props.releaseState === "pending" || props.releaseState === "held"
                  ? "Waiting for Codex to release this conversation…"
                  : props.releaseState === "unknown"
                    ? "Release could not be confirmed. Sending and handoff are blocked."
                    : props.releaseState === undefined && props.nativeId
                      ? "Native release has not been checked."
                      : syncing
                        ? "Refreshing saved Codex history…"
                        : "Shared Codex conversation · saved text sync"}
        </span>
        {props.nativeId && canSync ? (
          <InlineButton disabled={syncing || props.busy} onClick={() => void refresh()}>
            Refresh history
          </InlineButton>
        ) : null}
        {props.nativeId &&
        canSync &&
        (props.releaseState !== "ready" || (!titleSaved && !titleObserved)) ? (
          <InlineButton disabled={syncing || props.busy} onClick={() => void refresh(true)}>
            Check release
          </InlineButton>
        ) : null}
        {props.nativeId && props.canOpenLocally ? (
          <InlineButton disabled={opening || !ready} onClick={() => void open()}>
            Open in Codex Desktop
          </InlineButton>
        ) : null}
        {props.nativeId && canConnect ? (
          <InlineButton
            disabled={
              connecting ||
              syncing ||
              props.busy ||
              props.releaseState !== "ready" ||
              titleBlocksHandoff
            }
            onClick={() => void connect()}
          >
            {connecting ? "Connecting to Desktop…" : "Connect to Desktop"}
          </InlineButton>
        ) : null}
      </div>
      {props.nativeId ? (
        <p className="mt-1">
          {titleObserved
            ? "Title follows saved Codex data. Desktop display confirmation is pending."
            : titleSaved
              ? "Title saved to Codex history. Desktop confirmation is pending."
              : props.titlePreparation?.status === "conflict"
                ? `Native title differs: ${props.titlePreparation.observedTitle ?? "(empty)"}. Your T3 title is kept.`
                : props.titlePreparation?.status === "unknown" ||
                    props.titlePreparation?.status === "pending"
                  ? "Native title write outcome is unknown. Handoff is blocked; checking again does not replay the write."
                  : props.titlePreparation?.status === "unverified"
                    ? "Codex acknowledged the title write. Check release to verify the saved title."
                    : props.titlePreparation?.status === "unavailable"
                      ? "Native title preparation is unavailable. Your T3 title is kept; conversation release can continue."
                      : "The current T3 title is not saved to Codex history yet. Check release before opening Desktop."}
        </p>
      ) : null}
      {props.nativeId && !props.busy ? (
        <p className="mt-1">
          Saved text sync runs on the server. T3 requests release when no work or approval is
          pending. After release, open this conversation in Codex Desktop and connect it here to
          send from either app. The same conversation and history stay in this sidebar; Desktop must
          remain available for new messages.
        </p>
      ) : null}
      {props.canOpenLocally && !defaultHome ? (
        <p className="mt-1">
          This provider uses a custom Codex home. Open the same native ID in Codex configured for
          that home.
        </p>
      ) : null}
      {error ? (
        <p className="mt-1 text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
