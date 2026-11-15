import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { codexDesktopEnvironment } from "../../state/codexDesktop";
import { DesktopSavedHistory } from "./DesktopSavedHistory";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

export function DesktopHistoryPreview({
  environmentId,
  conversationId,
  sourceId,
  onClose,
}: {
  environmentId: EnvironmentId;
  conversationId: string;
  sourceId: string | null;
  onClose: () => void;
}) {
  const result = useAtomValue(
    codexDesktopEnvironment.historyLibrary({ environmentId, input: undefined }),
  );
  const library = Option.getOrNull(AsyncResult.value(result));
  const entry = library?.entries.find(
    (value) => value.conversationId === conversationId && value.sourceId === sourceId,
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{entry?.title ?? "Saved conversation"}</DialogTitle>
          <DialogDescription>
            Complete saved items, including tool records and attachment references.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex max-h-[70vh] min-h-0 flex-col">
          {entry ? (
            <DesktopSavedHistory
              key={`${environmentId}:${entry.sourceId}:${conversationId}`}
              environmentId={environmentId}
              sourceId={entry.sourceId}
              conversationId={conversationId}
            />
          ) : (
            <p role="status">
              This saved history source is unavailable. Refresh the library and reopen the
              conversation.
            </p>
          )}
          {AsyncResult.isFailure(result) ? (
            <p role="alert">The saved history library is unavailable.</p>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
