import type { ProviderAdapterV2RuntimeRequestResponseInput } from "@t3tools/provider-core/server/ProviderAdapter";
import { list, record, string } from "./protocol.ts";

const replyMethods: Readonly<Record<string, string>> = {
  "item/commandExecution/requestApproval": "thread-follower-command-approval-decision",
  "item/permissions/requestApproval": "thread-follower-permissions-request-approval-response",
  "item/tool/requestUserInput": "thread-follower-submit-user-input",
};
export interface DesktopRequestRef {
  readonly id: string | number;
  readonly method: string;
  readonly turnId: string;
  readonly epoch: string;
}
export interface DesktopRequest extends DesktopRequestRef {
  readonly key: string;
  readonly raw: Record<string, unknown>;
  readonly createdAtMs: number;
  readonly closedAtMs: number | null;
}
export const desktopReplyMethod = (method: string) => replyMethods[method];
export function desktopResponseKey(conversationId: string, nativeRef: string) {
  const ref = parseDesktopRequestRef(nativeRef);
  return `desktop-response:${JSON.stringify([conversationId, ref.turnId, ref.method, ref.id])}`;
}
export const desktopRequestRef = (request: DesktopRequestRef) =>
  JSON.stringify({
    id: request.id,
    method: request.method,
    turnId: request.turnId,
    epoch: request.epoch,
  });
export function parseDesktopRequestRef(value: string): DesktopRequestRef {
  const ref = record(JSON.parse(value));
  if (
    (typeof ref.id !== "string" && typeof ref.id !== "number") ||
    !string(ref.method) ||
    !string(ref.turnId) ||
    !string(ref.epoch)
  )
    throw new Error("Invalid Desktop request reference.");
  return {
    id: ref.id,
    method: string(ref.method),
    turnId: string(ref.turnId),
    epoch: string(ref.epoch),
  };
}
export class DesktopRequestHistory {
  private readonly requests = new Map<string, DesktopRequest>();
  update(state: Record<string, unknown>, epoch: string, now: number) {
    const pending = new Set<string>();
    for (const rawValue of list(state.requests)) {
      const raw = record(rawValue),
        params = record(raw.params),
        id = raw.id;
      if (
        (typeof id !== "string" && typeof id !== "number") ||
        !string(params.turnId) ||
        !string(raw.method)
      )
        continue;
      const key = `${epoch}:${string(params.turnId)}:${string(raw.method)}:${JSON.stringify(id)}`;
      pending.add(key);
      const old = this.requests.get(key);
      this.requests.set(key, {
        key,
        id,
        method: string(raw.method),
        turnId: string(params.turnId),
        epoch,
        raw,
        createdAtMs: old?.createdAtMs ?? now,
        closedAtMs: null,
      });
    }
    for (const [key, value] of this.requests)
      if (!pending.has(key) && value.closedAtMs === null)
        this.requests.set(key, { ...value, closedAtMs: now });
    return [...this.requests.values()];
  }
}
export function desktopRequestKind(request: DesktopRequest) {
  if (request.method === "item/tool/requestUserInput") return "user_input" as const;
  if (request.method === "item/fileChange/requestApproval") return "file-change" as const;
  if (request.method === "item/permissions/requestApproval") {
    const fileSystem = record(record(record(request.raw.params).permissions).fileSystem);
    if (
      list(fileSystem.write).length ||
      list(fileSystem.entries).some((entry) => record(entry).access === "write")
    )
      return "file-change" as const;
    if (
      list(fileSystem.read).length ||
      list(fileSystem.entries).some((entry) => record(entry).access === "read")
    )
      return "file-read" as const;
  }
  return "command" as const;
}
export function desktopRequestResponse(
  raw: Record<string, unknown>,
  input: ProviderAdapterV2RuntimeRequestResponseInput,
  answers: Readonly<Record<string, { readonly answers: ReadonlyArray<string> }>> = {},
) {
  if (input.feedback) throw new Error("This Desktop protocol cannot deliver approval feedback.");
  const params = record(raw.params);
  if (raw.method === "item/tool/requestUserInput") {
    if (input.answers === undefined) throw new Error("Answers are required.");
    const allowed = new Set(list(params.questions).map((q) => string(record(q).id)));
    if (!allowed.size || allowed.has("")) throw new Error("Desktop supplied invalid questions.");
    if (Object.keys(input.answers).some((id) => !allowed.has(id)))
      throw new Error("The question changed. Review the current request.");
    if ([...allowed].some((id) => !answers[id]?.answers.length))
      throw new Error("Answer every question before submitting.");
    return { response: { answers } };
  }
  const decision = input.decision;
  if (!decision || decision === "acceptAlways")
    throw new Error("Choose a single-request or explicit session decision supported by Desktop.");
  const available = list(params.availableDecisions);
  if (available.length && !available.includes(decision))
    throw new Error("Desktop does not offer this approval decision.");
  if (raw.method === "item/permissions/requestApproval")
    return {
      response: {
        permissions:
          decision === "accept" || decision === "acceptForSession"
            ? record(params.permissions)
            : {},
        scope: decision === "acceptForSession" ? "session" : "turn",
      },
    };
  if (raw.method === "item/commandExecution/requestApproval") return { decision };
  throw new Error("Answer this request in Codex Desktop.");
}
