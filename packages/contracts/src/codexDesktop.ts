import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { CodexSavedTitleRead } from "./threadType.ts";

const ConversationId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,100}$/));
export const CodexDesktopTarget = Schema.Struct({ conversationId: ConversationId });
export type CodexDesktopTarget = typeof CodexDesktopTarget.Type;
export const CodexDesktopBinding = Schema.Struct({
  threadId: ThreadId,
  uncertain: Schema.Array(
    Schema.Struct({ attemptId: Schema.String, candidateId: Schema.NullOr(Schema.String) }),
  ),
});
export const CodexDesktopBindInput = Schema.Struct({
  conversationId: ConversationId,
  dismissUnsentAttemptId: Schema.optional(Schema.String),
});
export const CodexDesktopAttachExistingInput = Schema.Struct({
  threadId: ThreadId,
  conversationId: ConversationId,
});
export type CodexDesktopBinding = typeof CodexDesktopBinding.Type;

/** Desktop organization is independent of the directory used to execute a T3 turn. */
export const CodexDesktopMembership = Schema.Struct({
  kind: Schema.Literals(["assigned", "none", "unknown"]),
  projectId: Schema.NullOr(Schema.String),
  projectTitle: Schema.NullOr(Schema.String),
  source: Schema.Literals(["native", "desktop-cache", "conflict", "unavailable"]),
});
export type CodexDesktopMembership = typeof CodexDesktopMembership.Type;

export const CodexDesktopHistoryEntry = Schema.Struct({
  conversationId: ConversationId,
  sourceId: Schema.String,
  attachedToThreadId: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.String,
  cwd: Schema.String,
  archived: Schema.Boolean,
  membership: CodexDesktopMembership,
  status: Schema.Literals(["pending", "cached", "unavailable"]),
  fetchedAt: Schema.NullOr(Schema.Number),
  updatedAt: Schema.Number,
  error: Schema.NullOr(Schema.String),
  classification: Schema.optional(Schema.Literals(["interactive", "unknown"])),
  canonicalTitle: Schema.optional(CodexSavedTitleRead),
});
export type CodexDesktopHistoryEntry = typeof CodexDesktopHistoryEntry.Type;
export const CodexDesktopHistoryOrigin = Schema.Struct({
  sourceId: Schema.String,
  nativeId: Schema.String,
  membership: CodexDesktopMembership,
  attachedToThreadId: Schema.NullOr(Schema.String),
  fetchedAt: Schema.Number,
});
export const CodexDesktopHistoryLibraryState = Schema.Struct({
  entries: Schema.Array(CodexDesktopHistoryEntry),
  sourceAvailable: Schema.Boolean,
  syncAvailable: Schema.optional(Schema.Boolean),
  detail: Schema.NullOr(Schema.String),
  cache: Schema.optional(
    Schema.Struct({
      sourceVersions: Schema.Number,
      sourceSnapshotBytes: Schema.Number,
      databaseBytes: Schema.Number,
    }),
  ),
  discovery: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["local", "api", "rollout"]),
      attemptedAt: Schema.Number,
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type CodexDesktopHistoryLibraryState = typeof CodexDesktopHistoryLibraryState.Type;
export const CodexDesktopHistoryPageInput = Schema.Struct({
  conversationId: ConversationId,
  sourceId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  cursor: Schema.optional(
    Schema.Struct({
      snapshot: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      offset: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});
export type CodexDesktopHistoryPageInput = typeof CodexDesktopHistoryPageInput.Type;
export const CodexDesktopHistoryPage = Schema.Struct({
  conversationId: ConversationId,
  thread: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(
    Schema.Struct({
      turn: Schema.Record(Schema.String, Schema.Unknown),
      item: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
      metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.Struct({ snapshot: Schema.String, offset: Schema.Number })),
  totalItems: Schema.Number,
});
export type CodexDesktopHistoryPage = typeof CodexDesktopHistoryPage.Type;

export const CodexDesktopMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant", "activity"]),
  text: Schema.String,
});
export type CodexDesktopMessage = typeof CodexDesktopMessage.Type;

const desktopMetadata = {
  conversationId: ConversationId,
  status: Schema.Literals(["connecting", "ready", "reconnecting", "unavailable", "incompatible"]),
  detail: Schema.String,
  epoch: Schema.String,
  revision: Schema.Number,
  title: Schema.String,
  cwd: Schema.String,
  model: Schema.String,
  permissions: Schema.optional(
    Schema.Struct({
      approvalPolicy: Schema.NullOr(Schema.String),
      sandboxMode: Schema.NullOr(Schema.String),
      runtimeMode: Schema.NullOr(Schema.Literals(["approval-required", "full-access"])),
    }),
  ),
  activeTurnId: Schema.NullOr(Schema.String),
  pendingRequests: Schema.Number,
  truncated: Schema.Boolean,
};
export const CodexDesktopState = Schema.Struct({
  ...desktopMetadata,
  messages: Schema.Array(CodexDesktopMessage),
});
export type CodexDesktopState = typeof CodexDesktopState.Type;

export const CodexDesktopUpdate = Schema.Struct({
  metadata: Schema.Struct(desktopMetadata),
  reset: Schema.Boolean,
  upsert: Schema.Array(CodexDesktopMessage),
  order: Schema.NullOr(Schema.Array(Schema.String)),
});
export type CodexDesktopUpdate = typeof CodexDesktopUpdate.Type;

export const CodexDesktopListInput = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  archived: Schema.optional(Schema.Literals(["active", "archived", "all"])),
  cursor: Schema.optional(Schema.Struct({ updatedAt: Schema.Number, id: ConversationId })),
});
export type CodexDesktopListInput = typeof CodexDesktopListInput.Type;

export const CodexDesktopList = Schema.Struct({
  supported: Schema.Boolean,
  detail: Schema.String,
  conversations: Schema.Array(
    Schema.Struct({
      conversationId: ConversationId,
      title: Schema.String,
      cwd: Schema.String,
      archived: Schema.optional(Schema.Boolean),
      updatedAt: Schema.optional(Schema.Number),
    }),
  ),
  nextCursor: Schema.optional(
    Schema.NullOr(Schema.Struct({ updatedAt: Schema.Number, id: ConversationId })),
  ),
});
export type CodexDesktopList = typeof CodexDesktopList.Type;

export const CodexDesktopPreview = Schema.Struct({
  conversationId: ConversationId,
  title: Schema.String,
  cwd: Schema.String,
  archived: Schema.Boolean,
  messages: Schema.Array(
    Schema.Struct({
      previewKey: Schema.String,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
    }),
  ),
  truncated: Schema.Boolean,
});
export type CodexDesktopPreview = typeof CodexDesktopPreview.Type;

export const CodexDesktopSend = Schema.Struct({
  conversationId: ConversationId,
  clientMessageId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,100}$/)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
  // Captures the sender's view. Legacy Desktop steering is rejected because it
  // cannot carry this guard to the owner; interrupt has its own native guard.
  expectedTurnId: Schema.NullOr(Schema.String),
});
export type CodexDesktopSend = typeof CodexDesktopSend.Type;
export const CodexDesktopStop = Schema.Struct({
  conversationId: ConversationId,
  expectedTurnId: Schema.String,
});
export type CodexDesktopStop = typeof CodexDesktopStop.Type;
export const CodexDesktopReceipt = Schema.Struct({ clientMessageId: Schema.String });

export class CodexDesktopError extends Schema.TaggedError<CodexDesktopError>()(
  "CodexDesktopError",
  {
    message: Schema.String,
    outcomeUnknown: Schema.Boolean,
  },
) {}
