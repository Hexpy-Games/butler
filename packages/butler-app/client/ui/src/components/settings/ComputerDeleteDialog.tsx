import { useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import {
  Button, ButtonContainer, CheckCard, CheckCardList, Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, Typo,
} from "@/butler-ds";
import type { Computer } from "./computersApi";

export function ComputerDeleteDialog({ computer, onCancel, onConfirm }: {
  computer: Computer | null;
  onCancel(): void;
  onConfirm(forget: boolean): void;
}) {
  const copy = appCopy.computers.removeDialog;
  const cancel = useRef<HTMLButtonElement>(null);
  const [forget, setForget] = useState(false);
  useEffect(() => { setForget(false); }, [computer?.id]);
  return (
    <Dialog open={computer !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent role="alertdialog" showCloseButton={false} size="sm" data-test-class="computer-delete-dialog"
        onPointerDownOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }}
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription><Typo.Text>{copy.body}</Typo.Text></DialogDescription>
        </DialogHeader>
        <CheckCardList label={copy.forget}>
          <CheckCard title={copy.forget} description={copy.forgetHint} checked={forget} onCheckedChange={setForget} />
        </CheckCardList>
        <DialogFooter>
          <ButtonContainer size="sm">
            <Button ref={cancel} type="button" size="sm" variant="ghost" onClick={onCancel}>{appCopy.common.cancel}</Button>
            <Button type="button" size="sm" variant="destructive" onClick={() => onConfirm(forget)}>{copy.confirm}</Button>
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
