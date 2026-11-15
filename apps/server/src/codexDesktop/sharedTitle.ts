import {
  threadTypeOf,
  type CodexTitleSync,
  type CodexDesktopHistoryEntry,
  type CodexNativeTitleRead,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";

const titleLineage = (thread: OrchestrationV2AppThread, observed: string) => [
  ...new Set(
    [
      ...(thread.codexTitleSync?.titleHistory ?? []),
      thread.title,
      thread.codexTitleSync?.desiredTitle,
      thread.codexTitleSync?.ownerTitle,
      thread.codexTitleSync?.expectedOwnerTitle,
      observed,
    ].filter((title): title is string => title != null),
  ),
];

export function queueSharedTitle(
  thread: OrchestrationV2AppThread,
  title: string,
  source: "initial" | "manual" | "generated",
): Pick<OrchestrationV2AppThread, "codexTitleSync"> {
  if (threadTypeOf(thread) !== "codex-shared") return {};
  const previous = thread.codexTitleSync;
  return {
    codexTitleSync: {
      status: "pending",
      version: (previous?.version ?? 0) + 1,
      desiredTitle: title,
      ownerTitle: previous?.ownerTitle ?? null,
      expectedOwnerTitle: previous?.ownerTitle ?? null,
      source,
      titleHistory: titleLineage(thread, title),
      ...(previous?.observation ? { observation: previous.observation } : {}),
      ...(previous?.saved ? { saved: previous.saved } : {}),
      ...(previous?.nativeSaved ? { nativeSaved: previous.nativeSaved } : {}),
    },
  };
}

/** Called under the thread commit lock, against the current durable local intent. */
export function observeSharedTitle(
  thread: OrchestrationV2AppThread,
  ownerTitle: string,
  observation?: { readonly epoch: string; readonly revision: number },
  unchangedIntent = true,
): Pick<OrchestrationV2AppThread, "title" | "codexTitleSync" | "titleRegeneration"> {
  if (!ownerTitle.trim()) return { title: thread.title };
  const previous = thread.codexTitleSync;
  if (
    observation &&
    previous?.observation?.epoch === observation.epoch &&
    previous.observation.revision >= observation.revision
  )
    return { title: thread.title };
  // Stream revisions and reconnects do not make an unchanged owner title newer than disk.
  if (
    previous?.source === "saved" &&
    (ownerTitle === previous.ownerTitle ||
      (previous.ownerTitle === null &&
        ownerTitle !== previous.desiredTitle &&
        previous.nativeSaved?.seenTitles.includes(ownerTitle)))
  )
    return {
      title: thread.title,
      codexTitleSync: { ...previous, ownerTitle, ...(observation ? { observation } : {}) },
    };
  const watermark = {
    titleHistory: titleLineage(thread, ownerTitle),
    ...(observation ? { observation } : {}),
    ...(previous?.saved
      ? { saved: { ...previous.saved, state: "candidate" as const, baselineTitle: null } }
      : {}),
    ...(previous?.nativeSaved
      ? {
          nativeSaved:
            ownerTitle !== previous.ownerTitle &&
            !(
              unchangedIntent &&
              ownerTitle === thread.title &&
              ownerTitle === previous.desiredTitle &&
              previous.nativeSaved.intentVersion === previous.version &&
              previous.nativeSaved.baselineTitle === thread.title
            )
              ? { ...previous.nativeSaved, state: "candidate" as const, baselineTitle: null }
              : previous.nativeSaved,
        }
      : {}),
  };
  const desiredTitle = previous?.desiredTitle ?? thread.title;
  if (!unchangedIntent)
    return {
      title: thread.title,
      codexTitleSync: {
        status: previous?.status === "conflict" ? "conflict" : "pending",
        version: previous?.version ?? 0,
        desiredTitle: thread.title,
        ownerTitle,
        expectedOwnerTitle: previous?.expectedOwnerTitle ?? previous?.ownerTitle ?? null,
        source: previous?.source ?? "manual",
        ...watermark,
      },
    };
  let state: CodexTitleSync;
  if (ownerTitle === desiredTitle) {
    state = {
      status: "confirmed",
      desiredTitle,
      ownerTitle,
      expectedOwnerTitle: ownerTitle,
      version: previous?.version ?? 0,
      source: previous?.source ?? "desktop",
    };
  } else if (previous?.status === "confirmed" || previous?.source === "saved") {
    // Only an acknowledged baseline can follow later Desktop changes automatically.
    state = {
      status: "confirmed",
      desiredTitle: ownerTitle,
      ownerTitle,
      expectedOwnerTitle: ownerTitle,
      version: previous.version + 1,
      source: "desktop",
    };
    return {
      title: ownerTitle,
      codexTitleSync: { ...state, ...watermark },
      titleRegeneration: null,
    };
  } else {
    state = {
      status:
        previous?.status === "conflict" ||
        (previous?.ownerTitle != null && previous.ownerTitle !== ownerTitle)
          ? "conflict"
          : "pending",
      desiredTitle,
      ownerTitle,
      version: previous?.version ?? 0,
      source: previous?.source ?? "manual",
      expectedOwnerTitle: previous?.expectedOwnerTitle ?? ownerTitle,
    };
  }
  return { title: desiredTitle, codexTitleSync: { ...state, ...watermark } };
}

/** A disk observation never acknowledges a live owner or resolves an outstanding local write. */
export function observeSavedTitle(
  thread: OrchestrationV2AppThread,
  entry: CodexDesktopHistoryEntry,
  unchangedIntent: boolean,
  nativeWriteSettled: boolean,
): Partial<Pick<OrchestrationV2AppThread, "title" | "codexTitleSync" | "titleRegeneration">> {
  const state = thread.codexTitleSync;
  const read = entry.canonicalTitle;
  if (
    !state ||
    !read?.name.trim() ||
    thread.codexDesktopHistory?.sourceId !== entry.sourceId ||
    thread.codexDesktopHistory.nativeId !== entry.conversationId
  )
    return {};
  const previous = state.saved;
  const sameCache =
    previous?.sourceId === entry.sourceId &&
    previous.nativeId === entry.conversationId &&
    previous.read.cacheEpoch === read.cacheEpoch;
  if (sameCache && previous.read.revision >= read.revision) return {};
  const known = new Set(
    [
      ...(state.titleHistory ?? []),
      ...(previous?.seenTitles ?? []),
      state.desiredTitle,
      state.ownerTitle,
      state.expectedOwnerTitle,
    ].filter((title): title is string => title != null),
  );
  const seenBefore = known.has(read.name);
  known.add(read.name);
  const saved: NonNullable<CodexTitleSync["saved"]> = {
    sourceId: entry.sourceId,
    nativeId: entry.conversationId,
    read,
    intentVersion: state.version,
    baselineTitle: null,
    seenTitles: [...known],
    state: "candidate",
  };
  if (state.nativeSaved || state.status !== "confirmed" || !unchangedIntent || !nativeWriteSettled)
    return { codexTitleSync: { ...state, saved } };
  if (
    read.name === thread.title &&
    state.ownerTitle === thread.title &&
    state.desiredTitle === thread.title
  )
    return {
      codexTitleSync: {
        ...state,
        saved: { ...saved, baselineTitle: thread.title, state: "baseline" },
      },
    };
  // A known old name may be a delayed write or an intentional rename back. Only the owner can decide.
  if (
    !sameCache ||
    previous.state !== "baseline" ||
    previous.intentVersion !== state.version ||
    previous.baselineTitle !== thread.title ||
    seenBefore
  )
    return {
      codexTitleSync: { ...state, saved: { ...saved, state: "conflict" } },
    };
  return {
    title: read.name,
    titleRegeneration: null,
    codexTitleSync: {
      ...state,
      status: "pending",
      version: state.version + 1,
      desiredTitle: read.name,
      expectedOwnerTitle: state.ownerTitle,
      source: "saved",
      titleHistory: titleLineage(thread, read.name),
      saved: { ...saved, state: "adopted" },
    },
  };
}

/** Metadata observations change only the read side; source=saved never requests native writes. */
export function observeNativeTitle(
  thread: OrchestrationV2AppThread,
  read: CodexNativeTitleRead,
  unchangedIntent: boolean,
  nativeWriteSettled: boolean,
  nativeIntentSaved = false,
): Partial<Pick<OrchestrationV2AppThread, "title" | "codexTitleSync" | "titleRegeneration">> {
  if (
    !read.name.trim() ||
    (thread.codexDesktopHistory &&
      (thread.codexDesktopHistory.sourceId !== read.sourceId ||
        thread.codexDesktopHistory.nativeId !== read.nativeId))
  )
    return {};
  const state: CodexTitleSync = thread.codexTitleSync ?? {
    status: "pending",
    version: 0,
    desiredTitle: thread.title,
    ownerTitle: null,
    expectedOwnerTitle: null,
    source: "saved",
  };
  const previous = state.nativeSaved;
  const sameSource =
    previous?.read.sourceId === read.sourceId && previous.read.nativeId === read.nativeId;
  if (previous && !sameSource) return {};
  const sameEpoch = sameSource && previous.read.epoch === read.epoch;
  if (sameEpoch && previous.read.revision >= read.revision) return {};
  // Candidate observations are not adopted lineage. In particular the full-history cache may
  // discover a new name before this reader does; that must not turn the new name into an ABA.
  const known = new Set(titleLineage(thread, thread.title));
  const seenBefore = known.has(read.name);
  const nativeSaved: NonNullable<CodexTitleSync["nativeSaved"]> = {
    read,
    intentVersion: state.version,
    baselineTitle: null,
    seenTitles: [...known],
    state: "candidate",
  };
  const patch = (value: typeof nativeSaved) => ({
    codexTitleSync: { ...state, nativeSaved: value },
  });
  if (
    !unchangedIntent ||
    !nativeWriteSettled ||
    thread.titleRegeneration ||
    state.status === "conflict" ||
    (state.status === "pending" && state.source !== "saved" && !nativeIntentSaved)
  )
    return patch(nativeSaved);
  const following =
    sameEpoch &&
    previous.intentVersion === state.version &&
    previous.baselineTitle === thread.title &&
    (previous.state === "baseline" || previous.state === "adopted");
  if (
    read.name === thread.title &&
    state.desiredTitle === thread.title &&
    (state.status === "confirmed" || state.source === "saved" || nativeIntentSaved)
  )
    return patch({ ...nativeSaved, baselineTitle: thread.title, state: "baseline" });
  if (!following || seenBefore) return patch({ ...nativeSaved, state: "conflict" });
  const version = state.version + 1;
  return {
    title: read.name,
    titleRegeneration: null,
    codexTitleSync: {
      ...state,
      status: "pending",
      source: "saved",
      desiredTitle: read.name,
      version,
      expectedOwnerTitle: state.ownerTitle,
      titleHistory: titleLineage(thread, read.name),
      nativeSaved: {
        ...nativeSaved,
        seenTitles: [...known, read.name],
        intentVersion: version,
        baselineTitle: read.name,
        state: "adopted",
      },
    },
  };
}
