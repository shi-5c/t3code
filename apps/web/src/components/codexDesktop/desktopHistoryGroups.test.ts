import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "../../types";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { groupSidebarDesktopHistory } from "./desktopHistoryGroups";

it("groups Desktop membership independently from cwd and keeps hosts and unverified memberships separate", () => {
  const environmentId = EnvironmentId.make("host-a");
  const projectId = ProjectId.make("workspace");
  const group = {
    id: projectId,
    projectKey: "ordinary",
    displayName: "Workspace",
    memberProjects: [{ id: projectId }],
    memberProjectRefs: [{ environmentId, projectId }],
  } as unknown as SidebarProjectSnapshot;
  const plain = { id: ThreadId.make("plain"), environmentId, projectId } as SidebarThreadSummary;
  const history = {
    sourceId: "source-a",
    nativeId: "original",
    fetchedAt: 1,
    attachedToThreadId: null,
    membership: { kind: "none", projectId: null, projectTitle: null, source: "desktop-cache" },
  } as const;
  const shared = { ...plain, id: ThreadId.make("shared"), codexDesktopHistory: history };
  const unknown = {
    ...shared,
    id: ThreadId.make("unknown"),
    codexDesktopHistory: {
      ...history,
      membership: {
        kind: "unknown",
        projectId: null,
        projectTitle: null,
        source: "conflict",
      } as const,
    },
  };
  const otherSource = {
    ...shared,
    id: ThreadId.make("other-source"),
    codexDesktopHistory: { ...history, sourceId: "source-b" },
  };
  const grouped = groupSidebarDesktopHistory(
    [group],
    [plain, shared, unknown, otherSource],
    () => true,
  );
  expect(grouped.map((value) => value.threads.map((thread) => thread.id))).toEqual([
    [plain.id],
    [shared.id],
    [unknown.id],
    [otherSource.id],
  ]);
  expect(grouped.map((value) => value.group.displayName)).toEqual([
    "Workspace",
    "Codex · No project",
    "Codex · Project unknown",
    "Codex · No project",
  ]);
  const moved = {
    ...shared,
    codexDesktopHistory: {
      ...history,
      membership: {
        kind: "assigned",
        projectId: "desktop-project",
        projectTitle: "Moved",
        source: "native",
      } as const,
    },
  };
  expect(groupSidebarDesktopHistory([group], [moved], () => false)[0]?.group.displayName).toBe(
    "Codex · Moved",
  );
  expect(moved.projectId).toBe(projectId);
});
