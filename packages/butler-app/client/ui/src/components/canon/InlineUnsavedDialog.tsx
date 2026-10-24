import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/butler-ds";

export function InlineUnsavedDialog({ open, busy, valid, decide, focus }: {
  open: boolean; busy: boolean; valid: boolean; focus: () => void;
  decide: (choice: "keep" | "discard" | "save") => Promise<void>;
}) {
  const copy = appCopy.canon;
  return <Dialog modal open={open} onOpenChange={value => { if (!value && !busy) void decide("keep"); }}>
    <DialogContent role="alertdialog" size="sm" showCloseButton={false} aria-describedby={undefined}
      onPointerDownOutside={event => event.preventDefault()}
      onCloseAutoFocus={event => { event.preventDefault(); focus(); }}>
      <DialogHeader><DialogTitle>{copy.inlineEdit.unsaved}</DialogTitle></DialogHeader>
      <DialogFooter><ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide("keep")}>{copy.inlineEdit.keep}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide("discard")}>{copy.inlineEdit.discard}</Button>
        <Button size="sm" disabled={busy || !valid} onClick={() => void decide("save")}>{copy.save}</Button>
      </ButtonContainer></DialogFooter>
    </DialogContent>
  </Dialog>;
}
