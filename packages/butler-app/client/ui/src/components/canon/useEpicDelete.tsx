import { apiErrorCode } from "@/app/api.ts";
import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { deleteCanonEpic, type EpicCard } from "@/app/canonApi.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { Button, ButtonContainer, Dialog, DialogContent, DialogForm } from "@/butler-ds";

export function useEpicDelete(epic: EpicCard) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const copy = appCopy.canon.deletion;
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteCanonEpic(epic.id, epic.revision);
      setOpen(false); notifyStatus(copy.deleted);
    } catch (error) {
      const code = apiErrorCode(error);
      if (code === "running" || code === "conflict") notifyStatus(code === "running" ? copy.running : appCopy.canon.conflict, { tone: "error" });
      else notifyError(error, appCopy.interfaceFeedback.requestFailed);
    }
    finally { setBusy(false); }
  };
  const dialog = <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
    <DialogContent size="sm" closeLabel={appCopy.canon.close} aria-describedby={undefined}>
      <DialogForm dialog title={copy.title(epic.title)} description={copy.detail} busy={busy}
        onSubmit={() => void submit()} footer={<ButtonContainer size="sm" justify="end">
          <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>{appCopy.canon.cancel}</Button>
          <Button size="sm" type="submit" variant="destructive" disabled={busy}>{copy.action}</Button>
        </ButtonContainer>}>{null}</DialogForm>
    </DialogContent>
  </Dialog>;
  return { request: () => setOpen(true), dialog };
}
