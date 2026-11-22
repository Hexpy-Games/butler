import { useState } from "react";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { Button, ButtonContainer, Card, CheckCard, Dialog, DialogContent, DialogForm, Stack, Tooltip, Typo } from "@/butler-ds";

export function ButlerBackupKeyDialog({ recoveryKey, busy, onCancel, onStart }: {
  recoveryKey: string;
  busy: boolean;
  onCancel: () => void;
  onStart: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const copy = appCopy.butlerBackup;
  const groups = recoveryKey.match(/.{6}/gu) ?? [];
  const firstLine = groups.slice(0, 4).join(" ");
  const secondLine = groups.slice(4).join(" ");

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      notifyStatus(copy.copied, { tone: "ok" });
    } catch {
      notifyStatus(copy.failedToast, { tone: "error" });
    }
  }

  async function saveKey() {
    const name = "butler-recovery-key.txt";
    try {
      if (window.butlerApp?.exportDocument) {
        await window.butlerApp.exportDocument({ format: "markdown", name, content: recoveryKey });
      } else {
        const url = URL.createObjectURL(new Blob([recoveryKey], { type: "text/plain;charset=utf-8" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch {
      notifyStatus(copy.failedToast, { tone: "error" });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent closeLabel={appCopy.common.close}>
        <DialogForm dialog title={copy.keyTitle} description={copy.keyBody}
          onSubmit={() => { if (saved && !busy) onStart(); }}
          footer={<ButtonContainer size="default" justify="end">
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>{copy.cancel}</Button>
            <Tooltip label={saved ? undefined : copy.startNeedsConfirm}>
              <Button type="submit" disabled={!saved || busy}>{copy.start}</Button>
            </Tooltip>
          </ButtonContainer>}>
          <Stack gap="sm">
            <Card radius="lg"><Stack gap="xs">
              <Typo.Code as="div" dir="ltr">{firstLine}</Typo.Code>
              <Typo.Code as="div" dir="ltr">{secondLine}</Typo.Code>
            </Stack></Card>
            <ButtonContainer size="sm" justify="start">
              <Button type="button" size="sm" variant="outline" onClick={() => void copyKey()}>{copy.copy}</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void saveKey()}>{copy.saveFile}</Button>
            </ButtonContainer>
            <CheckCard title={copy.saved} checked={saved} onCheckedChange={setSaved} disabled={busy} />
          </Stack>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
