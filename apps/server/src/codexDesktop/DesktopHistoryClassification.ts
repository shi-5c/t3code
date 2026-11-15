import { record } from "./protocol.ts";

type Classification = "internal" | "interactive" | "unknown";
export type DesktopHistoryClassificationEvidence = Readonly<
  Partial<Record<"local" | "rollout" | "api" | "canonical", Classification>>
>;

export function classifyDesktopHistory(metadata: Record<string, unknown>): Classification {
  if (
    metadata.ephemeral === true ||
    metadata.ephemeral === 1 ||
    metadata.parentThreadId ||
    metadata.parent_thread_id ||
    metadata.threadSource === "ambient_suggestions" ||
    metadata.thread_source === "ambient_suggestions"
  )
    return "internal";
  let source = metadata.source;
  if (typeof source === "string" && source.startsWith("{")) {
    try {
      source = JSON.parse(source);
    } catch {
      return "unknown";
    }
  }
  const object = record(source);
  if (
    source === "exec" ||
    [
      "subAgent",
      "subAgentReview",
      "subAgentCompact",
      "subAgentThreadSpawn",
      "subAgentOther",
    ].includes(typeof source === "string" ? source : "") ||
    "subagent" in object ||
    "subAgent" in object ||
    "sub_agent" in object
  )
    return "internal";
  return source === "cli" || source === "vscode" ? "interactive" : "unknown";
}

export function desktopHistoryClassification(evidence?: DesktopHistoryClassificationEvidence) {
  const values = Object.values(evidence ?? {});
  return values.includes("internal")
    ? "internal"
    : values.includes("interactive")
      ? "interactive"
      : "unknown";
}

/** Missing or degraded metadata cannot retract evidence tied to the same source and native ID. */
export function mergeDesktopHistoryClassification(
  previous: DesktopHistoryClassificationEvidence = {},
  observed: DesktopHistoryClassificationEvidence = {},
): DesktopHistoryClassificationEvidence {
  const merged = { ...previous };
  for (const origin of ["local", "rollout", "api", "canonical"] as const) {
    if (observed[origin] !== undefined)
      merged[origin] = desktopHistoryClassification({
        local: previous[origin] ?? "unknown",
        api: observed[origin],
      });
  }
  return merged;
}
