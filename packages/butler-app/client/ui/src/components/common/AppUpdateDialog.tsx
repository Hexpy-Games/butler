import { useEffect, useRef } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { useAppUpdateState } from "@/hooks/useAppUpdateState.ts";
import {
  Button, ButtonContainer, Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/butler-ds";

export function AppUpdateDialog() {
  useAppLocale();
  const state = useAppUpdateState();
  const laterRef = useRef<HTMLButtonElement>(null);
  const copy = appCopy.settings;
  useEffect(() => {
    if (state.status === "deferred") notifyStatus(copy.actions.updateDeferred, { id: "app-update" });
    if (state.status === "failed") notifyStatus(copy.errors.applyUpdate, { id: "app-update", tone: "error" });
  }, [state.status, copy.actions.updateDeferred, copy.errors.applyUpdate]);
  const choose = (action: "now" | "defer") => {
    void window.butlerApp?.chooseAppUpdate?.({ request_id: state.request_id, action });
  };
  if (state.status !== "choice_required") return null;
  return (
    <Dialog open onOpenChange={(open) => !open && choose("defer")}>
      <DialogContent
        role="alertdialog" showCloseButton={false} data-test-id="app-update-choice"
        onPointerDownOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => { event.preventDefault(); laterRef.current?.focus(); }}
      >
        <DialogHeader>
          <DialogTitle>{copy.actions.updateChoice}</DialogTitle>
          <DialogDescription>{copy.actions.updateCheckpoint}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <ButtonContainer size="sm">
            <Button ref={laterRef} size="sm" variant="ghost" onClick={() => choose("defer")}>
              {copy.actions.updateAfterWork}
            </Button>
            <Button size="sm" onClick={() => choose("now")}>{copy.actions.updateNow}</Button>
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
