import { useState } from "react";
import { appCopy } from "@/app/copy";
import { Button, ButtonContainer, Dialog, DialogContent, DialogForm, Input, SettingsField } from "@/butler-ds";

export function ButlerBackupRestoreDialog({ busy, onCancel, onRestore }: {
  busy: boolean;
  onCancel: () => void;
  onRestore: (key: string) => Promise<string | undefined>;
}) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string>();
  const copy = appCopy.butlerBackup;

  async function submit() {
    if (busy || !key.trim()) return;
    setError(await onRestore(key));
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent closeLabel={appCopy.common.close}>
        <DialogForm dialog title={copy.restore} description={copy.restoreBody} onSubmit={submit}
          footer={<ButtonContainer size="default" justify="end">
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>{copy.cancel}</Button>
            <Button type="submit" disabled={busy || !key.trim()}>{copy.restoreAction}</Button>
          </ButtonContainer>}>
          <SettingsField id="butler-backup-restore-key" label={copy.keyLabel} controlWidth="full" error={error}
            control={<Input id="butler-backup-restore-key" autoComplete="off" spellCheck={false} autoFocus
              value={key} disabled={busy} onChange={(event) => { setKey(event.target.value); setError(undefined); }} />} />
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
