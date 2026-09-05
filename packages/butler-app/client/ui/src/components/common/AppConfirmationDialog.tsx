import { useRef } from "react";
import { appCopy } from "@/app/copy.ts";
import { useConfirmationStore } from "@/app/confirmation.ts";
import {
  Button, ButtonContainer, Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/butler-ds";

export function AppConfirmationDialog() {
  const pending = useConfirmationStore((state) => state.pending);
  const cancelRef = useRef<HTMLButtonElement>(null);
  if (!pending) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && pending.resolve(false)}>
      <DialogContent
        role="alertdialog"
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          pending.returnFocus?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{pending.title ?? appCopy.common.confirm}</DialogTitle>
          <DialogDescription>{pending.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <ButtonContainer size="sm">
            <Button ref={cancelRef} size="sm" variant="ghost" onClick={() => pending.resolve(false)}>
              {appCopy.common.cancel}
            </Button>
            <Button size="sm" variant={pending.destructive ? "destructive" : "default"} onClick={() => pending.resolve(true)}>
              {pending.confirmLabel ?? appCopy.common.confirm}
            </Button>
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
