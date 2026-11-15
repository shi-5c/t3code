import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { groupSidebarThreadsByProject } from "../Sidebar.logic";

function desktopHistoryGroupTitle(
  history: NonNullable<SidebarThreadSummary["codexDesktopHistory"]>,
) {
  const membership = history.membership;
  return membership.kind === "none"
    ? "Codex · No project"
    : membership.kind === "assigned"
      ? `Codex · ${membership.projectTitle || membership.projectId}`
      : "Codex · Project unknown";
}

/** Display groups belong to each Desktop chat, independently of its execution workspace. */
export function groupSidebarDesktopHistory(
  groups: readonly SidebarProjectSnapshot[],
  threads: readonly SidebarThreadSummary[],
  keepEmpty: (group: SidebarProjectSnapshot) => boolean,
) {
  const ordinary = groupSidebarThreadsByProject(
    groups,
    threads.filter((thread) => !thread.codexDesktopHistory),
    (group) =>
      keepEmpty(group) &&
      !group.memberProjects.every((project) => project.id.startsWith("desktop-history-workspace:")),
  );
  const desktop = new Map<
    string,
    { group: SidebarProjectSnapshot; threads: SidebarThreadSummary[] }
  >();
  for (const thread of threads) {
    const history = thread.codexDesktopHistory;
    if (!history) continue;
    const key = `desktop-history:${thread.environmentId}:${history.sourceId}:${history.membership.kind}:${history.membership.projectId ?? ""}`;
    let folder = desktop.get(key);
    if (!folder) {
      const workspace = groups.find((group) =>
        group.memberProjectRefs.some(
          (ref) => ref.environmentId === thread.environmentId && ref.projectId === thread.projectId,
        ),
      );
      if (!workspace) continue;
      folder = {
        group: {
          ...workspace,
          projectKey: key,
          displayName: desktopHistoryGroupTitle(history),
          desktopHistoryGroup: true,
          memberProjectRefs: [],
          memberProjects: [],
        },
        threads: [],
      };
      desktop.set(key, folder);
    }
    folder.threads.push(thread);
  }
  return [...ordinary, ...desktop.values()];
}
