import * as Schema from "effect/Schema";

// This controls synchronization participation, not physical history isolation.
export const ThreadType = Schema.Literals(["t3", "codex-shared"]);
export type ThreadType = typeof ThreadType.Type;

export const CODEX_SHARED_INSTANCE_ID = "codex-desktop";
export const CodexSharedOwner = Schema.Literals(["native", "desktop"]);
export type CodexSharedOwner = typeof CodexSharedOwner.Type;

/** A successful canonical read, ordered within one private cache lifetime. */
export const CodexSavedTitleRead = Schema.Struct({
  cacheEpoch: Schema.String,
  revision: Schema.Number,
  snapshot: Schema.String,
  name: Schema.String,
});
export type CodexSavedTitleRead = typeof CodexSavedTitleRead.Type;

export const CodexNativeTitleRead = Schema.Struct({
  sourceId: Schema.String,
  nativeId: Schema.String,
  epoch: Schema.String,
  revision: Schema.Number,
  name: Schema.String,
});
export type CodexNativeTitleRead = typeof CodexNativeTitleRead.Type;

/** Confirmation refers to the live Desktop owner, not a native name write. */
export const CodexTitleSync = Schema.Struct({
  status: Schema.Literals(["pending", "confirmed", "conflict"]),
  version: Schema.Number,
  desiredTitle: Schema.String,
  ownerTitle: Schema.NullOr(Schema.String),
  expectedOwnerTitle: Schema.NullOr(Schema.String),
  source: Schema.Literals(["initial", "manual", "generated", "desktop", "saved"]),
  observation: Schema.optional(Schema.Struct({ epoch: Schema.String, revision: Schema.Number })),
  titleHistory: Schema.optional(Schema.Array(Schema.String)),
  nativeSaved: Schema.optional(
    Schema.Struct({
      read: CodexNativeTitleRead,
      intentVersion: Schema.Number,
      baselineTitle: Schema.NullOr(Schema.String),
      seenTitles: Schema.Array(Schema.String),
      state: Schema.Literals(["baseline", "candidate", "conflict", "adopted"]),
    }),
  ),
  saved: Schema.optional(
    Schema.Struct({
      sourceId: Schema.String,
      nativeId: Schema.String,
      read: CodexSavedTitleRead,
      intentVersion: Schema.Number,
      baselineTitle: Schema.NullOr(Schema.String),
      seenTitles: Schema.Array(Schema.String),
      state: Schema.Literals(["baseline", "candidate", "conflict", "adopted"]),
    }),
  ),
});
export type CodexTitleSync = typeof CodexTitleSync.Type;

/** Shared by release, connection and UI. A saved observation is not a local name/write intent. */
export function nativeTitleHandoffState(input: {
  readonly title: string;
  readonly titleVersion: number;
  readonly titleSource?: CodexTitleSync["source"] | undefined;
  readonly preparation?:
    | { readonly status: string; readonly desiredTitle: string; readonly version: number }
    | undefined;
}): "ready" | "unconfirmed" | "stale" {
  const prepared = input.preparation;
  if (prepared && ["pending", "unknown", "unverified"].includes(prepared.status))
    return "unconfirmed";
  if (
    prepared?.status === "saved" &&
    input.titleSource !== "saved" &&
    (prepared.desiredTitle !== input.title || prepared.version !== input.titleVersion)
  )
    return "stale";
  return "ready";
}

/** Legacy rows keep their original owner; only an explicit handoff changes it. */
export function codexSharedOwnerOf(thread: {
  readonly threadType?: ThreadType | undefined;
  readonly codexSharedOwner?: CodexSharedOwner | undefined;
  readonly providerInstanceId: string;
}): CodexSharedOwner | null {
  if (threadTypeOf(thread) !== "codex-shared") return null;
  return (
    thread.codexSharedOwner ??
    (thread.providerInstanceId === CODEX_SHARED_INSTANCE_ID ? "desktop" : "native")
  );
}

export function threadTypeOf(thread: {
  readonly threadType?: ThreadType | undefined;
  readonly providerInstanceId: string;
}): ThreadType {
  return (
    thread.threadType ??
    (thread.providerInstanceId === CODEX_SHARED_INSTANCE_ID ? "codex-shared" : "t3")
  );
}
