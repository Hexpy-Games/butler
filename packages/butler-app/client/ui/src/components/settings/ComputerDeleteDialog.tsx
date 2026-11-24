import { useRef } from "react";
import { appCopy } from "@/app/copy.ts";
import {
  Button, ButtonContainer, CheckCard, CheckCardList, Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, Typo,
} from "@/butler-ds";
import type { Computer } from "./computersApi";

export function ComputerDeleteDialog({ computer, unreachable, forget, onForgetChange, onCancel, onConfirm }: {
  computer: Computer | null;
  unreachable: boolean;
  forget: boolean;
  onForgetChange(forget: boolean): void;
  onCancel(): void;
  onConfirm(forget: boolean, force: boolean): void;
}) {
  const copy = appCopy.computers.removeDialog;
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={computer !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent role="alertdialog" showCloseButton={false} size="sm" data-test-class="computer-delete-dialog"
        onPointerDownOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }}
      >
        <DialogHeader>
          <DialogTitle>{unreachable ? copy.unreachableTitle : copy.title}</DialogTitle>
          <DialogDescription><Typo.Text>{unreachable ? copy.unreachableBody : copy.body}</Typo.Text></DialogDescription>
        </DialogHeader>
        {!unreachable && <CheckCardList label={copy.forget}>
          <CheckCard title={copy.forget} description={copy.forgetHint} checked={forget} onCheckedChange={onForgetChange} />
        </CheckCardList>}
        <DialogFooter>
          <ButtonContainer size="sm">
            <Button ref={cancel} type="button" size="sm" variant="ghost" onClick={onCancel}>{appCopy.common.cancel}</Button>
            <Button type="button" size="sm" variant="destructive" onClick={() => onConfirm(forget, unreachable)}>{unreachable ? copy.forceConfirm : copy.confirm}</Button>
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
