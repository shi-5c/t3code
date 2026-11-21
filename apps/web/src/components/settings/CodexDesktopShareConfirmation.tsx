import { AlertTriangleIcon } from "lucide-react";
import { type RefObject, useRef } from "react";
import { useGT } from "gt-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

export function CodexDesktopShareConfirmation(props: {
  readonly action: "add" | "enable" | "disable";
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
  readonly unavailableReason?: string | undefined;
  readonly finalFocus?: RefObject<HTMLButtonElement | null>;
}) {
  const gt = useGT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const adding = props.action === "add";
  const restoring = props.action === "disable";
  const blocked = props.action === "enable" && props.unavailableReason !== undefined;
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup initialFocus={cancelRef} finalFocus={props.finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {adding
              ? gt("Add Codex Desktop Share?")
              : blocked
                ? gt("Codex Desktop Share is unavailable")
                : restoring
                  ? gt("Restore Codex Desktop?")
                  : gt("Restart Codex Desktop?")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <span className="flex items-start gap-2">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <span>
                {adding
                  ? gt(
                      "This provider requires Codex Desktop on the T3 host. Enabling it changes how the desktop app launches the Codex CLI and can affect other desktop features.",
                    )
                  : restoring
                    ? gt(
                        "T3 Code will restore the original launch configuration. Codex Desktop may restart and interrupt active work.",
                      )
                    : (props.unavailableReason ??
                      gt(
                        "T3 Code will configure the bridge and restart Codex Desktop on this host. Running tasks, approvals, or unsaved input may be affected.",
                      ))}
              </span>
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button ref={cancelRef} variant="outline" />}>
            {blocked ? gt("Close") : gt("Cancel")}
          </AlertDialogClose>
          {blocked ? null : (
            <AlertDialogAction onClick={props.onConfirm}>
              {adding
                ? gt("Add")
                : restoring
                  ? gt("Disable and restore")
                  : gt("Enable and restart")}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
