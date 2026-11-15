/** Forward content/model choices while the Desktop owner resolves its current permissions.
 * In particular, neither T3's runtime-mode defaults nor app-server defaults may replace them.
 */
export function ownerTurnRequest(request: Record<string, unknown>) {
  const allowed = [
    "threadId",
    "input",
    "clientUserMessageId",
    "model",
    "effort",
    "summary",
    "serviceTier",
    "collaborationMode",
    "additionalContext",
  ];
  return Object.fromEntries(
    allowed.filter((key) => request[key] !== undefined).map((key) => [key, request[key]]),
  );
}
