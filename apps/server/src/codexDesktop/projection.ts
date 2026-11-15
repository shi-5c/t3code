import type { CodexDesktopMessage, CodexDesktopState } from "@t3tools/contracts";
import { list, record, string } from "./protocol.ts";

export function desktopPermissions(
  state: Record<string, unknown>,
): NonNullable<CodexDesktopState["permissions"]> {
  const current = record(state.currentPermissions);
  const approvalPolicy =
    typeof current.approvalPolicy === "string"
      ? current.approvalPolicy
      : current.approvalPolicy && typeof current.approvalPolicy === "object"
        ? "custom"
        : null;
  const sandboxMode = string(record(current.sandboxPolicy).type) || null;
  return {
    approvalPolicy,
    sandboxMode,
    runtimeMode:
      approvalPolicy === "never" && sandboxMode === "dangerFullAccess"
        ? "full-access"
        : approvalPolicy === "untrusted" && sandboxMode === "readOnly"
          ? "approval-required"
          : null,
  };
}

export function desktopTurns(state: Record<string, unknown>) {
  const history = record(record(state.turnHistory).history);
  const entities = record(history.entitiesByKey);
  const turns: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const island of list(history.islands))
    for (const entry of list(record(island).entries)) {
      const key = string(record(entry).key);
      if (key && !seen.has(key) && Object.hasOwn(entities, key)) {
        seen.add(key);
        turns.push(record(entities[key]));
      }
    }
  if (!turns.length) for (const turn of list(state.turns)) turns.push(record(turn));
  return turns;
}

export function projectDesktopConversation(
  state: Record<string, unknown>,
): Pick<
  CodexDesktopState,
  | "title"
  | "cwd"
  | "model"
  | "permissions"
  | "activeTurnId"
  | "pendingRequests"
  | "messages"
  | "truncated"
> {
  const history = record(record(state.turnHistory).history);
  const turns = desktopTurns(state);
  const messages: CodexDesktopMessage[] = [];
  let activeTurnId: string | null = null;
  const textOf = (value: unknown) =>
    list(value)
      .map((part) => string(record(part).text))
      .filter(Boolean)
      .join("\n");
  for (const [turnIndex, turn] of turns.entries()) {
    const turnId = string(turn.turnId) || `turn-${turnIndex}`;
    if (turn.status === "inProgress") activeTurnId = string(turn.turnId) || null;
    const items = list(turn.items).map(record);
    // Optimistic turns have params.input before userMessage is emitted; use one source.
    if (!items.some((item) => item.type === "userMessage")) {
      const params = record(turn.params);
      const text = textOf(params.input);
      if (text)
        messages.push({
          id: string(params.clientUserMessageId) || `${turnId}:input`,
          role: "user",
          text,
        });
    }
    for (const [index, item] of items.entries()) {
      const id = string(item.clientId) || string(item.id) || `${turnId}:${index}`;
      if (item.type === "userMessage")
        messages.push({ id, role: "user", text: textOf(item.content) });
      else if (item.type === "agentMessage")
        messages.push({ id, role: "assistant", text: string(item.text) });
      else if (item.type !== "reasoning") {
        // Tools remain visible without forwarding rich objects, credentials or binary assets.
        const label = string(item.name) || string(item.type);
        if (label)
          messages.push({
            id,
            role: "activity",
            text: [label, string(item.command), string(item.output)]
              .filter(Boolean)
              .join("\n")
              .slice(0, 16_000),
          });
      }
    }
    if (turn.error)
      messages.push({
        id: `${turnId}:error`,
        role: "activity",
        text: string(record(turn.error).message) || "Codex Desktop reported a turn error.",
      });
  }
  if (record(state.threadRuntimeStatus).type === "idle") activeTurnId = null;
  // Keep each wire update bounded. Desktop retains the full canonical history.
  let bytesRemaining = 1_000_000;
  const bounded: CodexDesktopMessage[] = [];
  let truncated = messages.length > 300 || history.isComplete === false;
  for (const message of messages.slice(-300).toReversed()) {
    const text = message.text.slice(-Math.min(64_000, bytesRemaining));
    if (text.length !== message.text.length) truncated = true;
    bounded.push({ ...message, text });
    bytesRemaining -= text.length;
    if (bytesRemaining <= 0) {
      truncated = true;
      break;
    }
  }
  return {
    title: string(state.title) || "Codex Desktop conversation",
    cwd: string(state.cwd),
    model: string(state.latestModel),
    permissions: desktopPermissions(state),
    activeTurnId,
    pendingRequests: list(state.requests).length,
    messages: bounded.toReversed(),
    truncated,
  };
}
