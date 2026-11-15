import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  type OrchestrationV2AppThread,
  type CodexDesktopHistoryEntry,
} from "@t3tools/contracts";
import {
  observeSharedTitle,
  observeSavedTitle,
  observeNativeTitle,
  queueSharedTitle,
} from "./sharedTitle.ts";

const titleRead = (name: string, revision: number, epoch = "metadata") => ({
  name,
  revision,
  epoch,
  sourceId: "source",
  nativeId: "native",
});
const initialTitle = () =>
  ({
    title: "A",
    threadType: "codex-shared",
    providerInstanceId: ProviderInstanceId.make("codex-desktop"),
    codexDesktopHistory: { sourceId: "source", nativeId: "native" },
  }) as OrchestrationV2AppThread;
const followTitle = (
  thread: OrchestrationV2AppThread,
  name: string,
  revision: number,
  epoch?: string,
) => ({ ...thread, ...observeNativeTitle(thread, titleRead(name, revision, epoch), true, true) });

describe("read-only native titles", () => {
  it("continues following when the owner confirms the already adopted name", () => {
    let thread = followTitle(initialTitle(), "A", 1);
    thread = followTitle(thread, "B", 2);
    thread = { ...thread, ...observeSharedTitle(thread, "B", { epoch: "owner", revision: 1 }) };
    expect(thread.codexTitleSync?.status).toBe("confirmed");
    expect(followTitle(thread, "C", 3).title).toBe("C");
  });
  it("follows a durably saved native intent while Desktop confirmation is pending", () => {
    let thread = { ...initialTitle(), ...queueSharedTitle(initialTitle(), "A", "generated") };
    thread = { ...thread, ...observeNativeTitle(thread, titleRead("A", 1), true, true, true) };
    thread = { ...thread, ...observeNativeTitle(thread, titleRead("B", 2), true, true, true) };
    expect(thread.title).toBe("B");
    expect(thread.codexTitleSync).toMatchObject({
      source: "saved",
      status: "pending",
      ownerTitle: null,
    });
    expect(followTitle(thread, "C", 3).title).toBe("C");
  });
  it.each(["epoch", "intent-race", "unsettled", "generation"])(
    "recovers its baseline after %s without acknowledging the owner",
    (reason) => {
      let thread = followTitle(initialTitle(), "A", 1);
      thread = followTitle(thread, "B", 2);
      expect(thread.title).toBe("B");
      const epoch = reason === "epoch" ? "new-cache" : "metadata";
      thread = {
        ...thread,
        ...observeNativeTitle(
          {
            ...thread,
            ...(reason === "generation"
              ? {
                  titleRegeneration: {} as NonNullable<
                    OrchestrationV2AppThread["titleRegeneration"]
                  >,
                }
              : {}),
          },
          titleRead("B", 3, epoch),
          reason !== "intent-race",
          reason !== "unsettled",
        ),
      };
      thread = followTitle(thread, "B", 4, epoch);
      thread = followTitle(thread, "C", 5, epoch);
      expect(thread.title).toBe("C");
      expect(thread.codexTitleSync).toMatchObject({
        status: "pending",
        source: "saved",
        ownerTitle: null,
      });
    },
  );
  it("does not treat full-cache candidates as adopted lineage", () => {
    let thread = followTitle(initialTitle(), "A", 1);
    thread = {
      ...thread,
      ...observeSavedTitle(
        thread,
        {
          sourceId: "source",
          conversationId: "native",
          canonicalTitle: { name: "B", revision: 1, cacheEpoch: "full", snapshot: "hash" },
        } as CodexDesktopHistoryEntry,
        true,
        true,
      ),
    };
    thread = followTitle(thread, "B", 2);
    expect(thread.title).toBe("B");
    thread = followTitle(thread, "C", 3);
    expect(thread.title).toBe("C");
  });
  it("protects manual writes, stale reads, ambiguous ABA and source binding", () => {
    let thread = followTitle(initialTitle(), "A", 1);
    thread = followTitle(thread, "B", 2);
    expect(followTitle(thread, "A", 3).title).toBe("B");
    expect(followTitle(thread, "C", 1)).toEqual(thread);
    expect(
      observeNativeTitle(thread, { ...titleRead("C", 3), sourceId: "other" }, true, true),
    ).toEqual({});
    const manual = { ...thread, title: "Manual", ...queueSharedTitle(thread, "Manual", "manual") };
    expect(followTitle(manual, "C", 4).title).toBe("Manual");
    expect(observeNativeTitle(thread, titleRead("C", 4), true, false)).toMatchObject({
      codexTitleSync: { nativeSaved: { state: "candidate" } },
    });
    thread = { ...thread, ...observeSharedTitle(thread, "A", { epoch: "owner", revision: 1 }) };
    expect(thread.title).toBe("B");
    thread = {
      ...thread,
      ...observeSharedTitle(thread, "A", { epoch: "reconnected", revision: 1 }),
    };
    expect(thread.title).toBe("B");
    thread = {
      ...thread,
      ...observeSharedTitle(thread, "D", { epoch: "reconnected", revision: 2 }),
    };
    expect(thread.title).toBe("D");
    expect(thread.codexTitleSync?.status).toBe("confirmed");
  });
});

describe("shared title intent", () => {
  it("requires an unchanged confirmed baseline for saved titles and keeps ambiguous or unsettled writes pending", () => {
    let thread = {
      title: "A",
      threadType: "codex-shared",
      providerInstanceId: ProviderInstanceId.make("codex-desktop"),
      codexDesktopHistory: { sourceId: "source", nativeId: "native" },
    } as OrchestrationV2AppThread;
    thread = { ...thread, ...observeSharedTitle(thread, "A", { epoch: "owner", revision: 1 }) };
    const entry = (name: string, revision: number, cacheEpoch = "cache") =>
      ({
        sourceId: "source",
        conversationId: "native",
        canonicalTitle: { name, revision, cacheEpoch, snapshot: String(revision) },
      }) as CodexDesktopHistoryEntry;
    let manuallyRenamed = {
      ...thread,
      title: "Manual B",
      ...queueSharedTitle(thread, "Manual B", "manual"),
    };
    manuallyRenamed = {
      ...manuallyRenamed,
      ...observeSharedTitle(manuallyRenamed, "Manual B", { epoch: "owner", revision: 2 }),
    };
    manuallyRenamed = {
      ...manuallyRenamed,
      ...observeSavedTitle(manuallyRenamed, entry("Manual B", 1), true, true),
    };
    manuallyRenamed = {
      ...manuallyRenamed,
      ...observeSavedTitle(manuallyRenamed, entry("A", 2), true, true),
    };
    expect(manuallyRenamed.title).toBe("Manual B");
    expect(manuallyRenamed.codexTitleSync?.saved?.state).toBe("conflict");
    thread = { ...thread, ...observeSavedTitle(thread, entry("A", 1), true, true) };
    for (const [unchanged, settled] of [
      [false, true],
      [true, false],
    ]) {
      const candidate = {
        ...thread,
        ...observeSavedTitle(thread, entry("B", 2), unchanged!, settled!),
      };
      expect(candidate.title).toBe("A");
      expect(candidate.codexTitleSync?.saved?.state).toBe("candidate");
    }
    const changedCache = {
      ...thread,
      ...observeSavedTitle(thread, entry("B", 2, "recreated-cache"), true, true),
    };
    expect(changedCache.title).toBe("A");
    expect(changedCache.codexTitleSync?.saved?.state).toBe("conflict");
    const manual = { ...thread, title: "Manual", ...queueSharedTitle(thread, "Manual", "manual") };
    const pending = { ...manual, ...observeSavedTitle(manual, entry("B", 2), true, true) };
    expect(pending.title).toBe("Manual");
    expect(pending.codexTitleSync?.version).toBe(manual.codexTitleSync?.version);
    expect(pending.codexTitleSync?.status).toBe("pending");
    thread = { ...thread, ...observeSavedTitle(thread, entry("B", 2), true, true) };
    expect(thread.title).toBe("B");
    expect(thread.codexTitleSync?.status).toBe("pending");
    expect(thread.codexTitleSync?.ownerTitle).toBe("A");
    for (const observation of [
      { epoch: "owner", revision: 2 },
      { epoch: "reconnected", revision: 1 },
    ]) {
      const unchangedOwner = {
        ...thread,
        ...observeSharedTitle(thread, "A", observation),
      };
      expect(unchangedOwner.title).toBe("B");
      expect(unchangedOwner.codexTitleSync).toEqual({
        ...thread.codexTitleSync,
        observation,
      });
      const changedOwner = {
        ...unchangedOwner,
        ...observeSharedTitle(unchangedOwner, "C", {
          ...observation,
          revision: observation.revision + 1,
        }),
      };
      expect(changedOwner.title).toBe("C");
      expect(changedOwner.codexTitleSync?.status).toBe("confirmed");
      const newerManual = {
        ...unchangedOwner,
        title: "D",
        ...queueSharedTitle(unchangedOwner, "D", "manual"),
      };
      expect(
        observeSharedTitle(newerManual, "C", {
          ...observation,
          revision: observation.revision + 1,
        }),
      ).toMatchObject({ title: "D", codexTitleSync: { source: "manual", status: "conflict" } });
    }
    const ownerChanged = {
      ...thread,
      ...observeSharedTitle(thread, "Authoritative C", { epoch: "owner", revision: 3 }),
    };
    expect(ownerChanged.title).toBe("Authoritative C");
    expect(ownerChanged.codexTitleSync?.status).toBe("confirmed");
    expect(ownerChanged.codexTitleSync?.source).toBe("desktop");
    expect(observeSavedTitle(thread, entry("A", 1), true, true)).toEqual({});
    thread = { ...thread, ...observeSharedTitle(thread, "B", { epoch: "owner", revision: 2 }) };
    thread = { ...thread, ...observeSavedTitle(thread, entry("B", 3), true, true) };
    thread = { ...thread, ...observeSavedTitle(thread, entry("A", 4), true, true) };
    expect(thread.title).toBe("B");
    expect(thread.codexTitleSync?.saved?.state).toBe("conflict");
    expect(thread.codexTitleSync?.ownerTitle).toBe("B");
    expect(thread.codexTitleSync?.saved?.read.name).toBe("A");
    thread = { ...thread, ...observeSharedTitle(thread, "C", { epoch: "owner", revision: 3 }) };
    expect(thread.title).toBe("C");
    expect(thread.codexTitleSync?.status).toBe("confirmed");
    expect(thread.codexTitleSync?.saved?.state).toBe("candidate");
    expect(
      observeSavedTitle(thread, { ...entry("Other", 5), sourceId: "other" }, true, true),
    ).toEqual({});
  });
  it("keeps manual intent across stale owner updates, conflict, restart and confirmation", () => {
    let thread = {
      title: "Original",
      threadType: "codex-shared",
      providerInstanceId: ProviderInstanceId.make("codex-desktop"),
    } as OrchestrationV2AppThread;
    thread = { ...thread, ...observeSharedTitle(thread, "Original") };
    thread = {
      ...thread,
      title: "Manual one",
      ...queueSharedTitle(thread, "Manual one", "manual"),
    };
    thread = {
      ...thread,
      title: "Manual two",
      ...queueSharedTitle(thread, "Manual two", "manual"),
    };
    expect(thread.codexTitleSync?.version).toBe(2);
    thread = { ...thread, ...observeSharedTitle(thread, "Original") };
    expect(thread.codexTitleSync?.status).toBe("pending");
    thread = { ...thread, ...observeSharedTitle(thread, "Manual one") };
    expect(thread.title).toBe("Manual two");
    expect(thread.codexTitleSync).toMatchObject({
      status: "conflict",
      ownerTitle: "Manual one",
      expectedOwnerTitle: "Original",
      version: 2,
    });
    thread = JSON.parse(JSON.stringify(thread));
    thread = { ...thread, ...observeSharedTitle(thread, "Manual two") };
    expect(thread.codexTitleSync?.status).toBe("confirmed");
    thread = { ...thread, ...observeSharedTitle(thread, "Desktop rename") };
    expect(thread.title).toBe("Desktop rename");
    expect(thread.titleRegeneration).toBeNull();
    expect(observeSharedTitle(thread, "Desktop rename")).toMatchObject({
      codexTitleSync: thread.codexTitleSync,
    });
    thread = {
      ...thread,
      ...observeSharedTitle(thread, "Desktop rename", { epoch: "old", revision: 50 }),
    };
    thread = {
      ...thread,
      ...observeSharedTitle(thread, "Reconnected name", { epoch: "new", revision: 1 }),
    };
    expect(thread.title).toBe("Reconnected name");
    expect(thread.codexTitleSync?.observation).toEqual({ epoch: "new", revision: 1 });
  });
  it("keeps legacy and newly generated T3 titles pending until a matching Desktop observation", () => {
    const thread = {
      title: "Local",
      threadType: "codex-shared",
      providerInstanceId: ProviderInstanceId.make("codex"),
    } as OrchestrationV2AppThread;
    expect(observeSharedTitle(thread, "Native title")).toMatchObject({
      title: "Local",
      codexTitleSync: { status: "pending", ownerTitle: "Native title" },
    });
    expect(queueSharedTitle(thread, "Generated", "generated")).toMatchObject({
      codexTitleSync: { status: "pending", source: "generated" },
    });
    expect(queueSharedTitle({ ...thread, threadType: "t3" }, "Other", "manual")).toEqual({});
  });
});
