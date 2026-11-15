import type { CodexDesktopMembership } from "@t3tools/contracts";
import { record, string } from "./protocol.ts";

/** Cache evidence can disagree. A directory is never evidence of Desktop membership. */
export function desktopHistoryMembership(
  nativeId: string,
  nativeProjectId: unknown,
  desktopCache: unknown,
): CodexDesktopMembership {
  const cache = record(desktopCache);
  const projects = record(cache["local-projects"]);
  const nativeProject = string(nativeProjectId);
  if (nativeProject)
    return {
      kind: "assigned",
      projectId: nativeProject,
      projectTitle: string(record(projects[nativeProject]).name) || null,
      source: "native",
    };
  const unassigned =
    Array.isArray(cache["projectless-thread-ids"]) &&
    cache["projectless-thread-ids"].includes(nativeId);
  const assignment = record(record(cache["thread-project-assignments"])[nativeId]);
  const assigned = string(assignment.projectId);
  const host = record(cache["thread-project-membership-host-ids"])[nativeId];
  if ((unassigned && assigned) || (host !== undefined && host !== "local"))
    return { kind: "unknown", projectId: null, projectTitle: null, source: "conflict" };
  if (unassigned)
    return { kind: "none", projectId: null, projectTitle: null, source: "desktop-cache" };
  if (assigned && assignment.projectKind === "local" && string(record(projects[assigned]).id))
    return {
      kind: "assigned",
      projectId: assigned,
      projectTitle: string(record(projects[assigned]).name) || null,
      source: "desktop-cache",
    };
  return { kind: "unknown", projectId: null, projectTitle: null, source: "unavailable" };
}
