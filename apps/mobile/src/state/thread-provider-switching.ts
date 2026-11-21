import { codexDesktopShareThreadOwner } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSupportsProviderHandoff } from "@t3tools/client-runtime/state/thread-workflows";
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";

type ThreadStartMarkers = Pick<
  EnvironmentThreadShell,
  "latestRun" | "latestUserMessageAt" | "runtime"
> &
  Partial<Pick<EnvironmentThreadShell, "providerInstanceId" | "threadType">>;

function threadShellHasStarted(thread: ThreadStartMarkers | null | undefined): boolean {
  return Boolean(
    thread &&
    (thread.latestRun !== null || thread.latestUserMessageAt !== null || thread.runtime !== null),
  );
}

export function threadAllowsProviderSwitch(input: {
  readonly thread: ThreadStartMarkers | null | undefined;
  readonly projection: ThreadStructure | null | undefined;
}): boolean {
  const thread = input.thread;
  if (
    thread?.providerInstanceId &&
    codexDesktopShareThreadOwner({
      providerInstanceId: thread.providerInstanceId,
      threadType: thread.threadType,
    }) !== null
  )
    return false;
  return input.projection != null
    ? threadSupportsProviderHandoff(input.projection)
    : !threadShellHasStarted(input.thread);
}
