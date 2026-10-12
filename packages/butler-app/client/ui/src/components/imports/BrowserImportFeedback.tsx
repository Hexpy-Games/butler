import { useId, useState } from "react";
import { appCopy } from "@/app/copy";
import { Button, ButtonContainer, Input, Stack, Typo } from "@/butler-ds";
import { openImportDiskAccess } from "../settings/signInsApi";
import type { useBrowserImport } from "../settings/useBrowserImport";

export function BrowserImportFeedback({ flow }: { flow: ReturnType<typeof useBrowserImport> }) {
  const copy = appCopy.settings.browserImport;
  const primaryId = useId();
  const [diskHint, setDiskHint] = useState(false);
  const permission = flow.error === "full_disk_access_required";
  const needsPrimary = flow.error === "primary_password_required" || flow.error === "incorrect_primary_password";
  function submitPrimary() {
    const input = document.getElementById(primaryId) as HTMLInputElement | null;
    const value = input?.value ?? "";
    if (input) input.value = "";
    void flow.run(flow.selected, value);
  }
  return <>
      {flow.exportId ? <Stack gap="sm" role="status"><Typo.Caption>{copy.waitingCsv}</Typo.Caption>
        <ButtonContainer size="sm"><Button size="sm" variant="ghost" onClick={() => void flow.selectCsv()}>{copy.chooseFile}</Button><Button size="sm" variant="ghost" onClick={() => void flow.cancel()}>{copy.cancel}</Button></ButtonContainer>
      </Stack> : null}
      {permission ? <Stack gap="sm" data-test-class="import-permission" role="alert">
        <Typo.Caption>{copy.fullDiskAccess}</Typo.Caption>
        <ButtonContainer size="sm">
          <Button size="sm" disabled={flow.busy} onClick={() => void flow.folder()}>{copy.pickFolder}</Button>
          <Button size="sm" variant="ghost" disabled={flow.busy} onClick={() => void openImportDiskAccess().then(() => setDiskHint(true))}>{copy.diskAccess}</Button>
        </ButtonContainer>
        {diskHint ? <Typo.Caption tone="secondary">{copy.restartAfterAccess}</Typo.Caption> : null}
      </Stack> : needsPrimary ? <Stack gap="sm" role="alert">
        <Typo.Caption>{flow.error === "incorrect_primary_password" ? copy.wrongPrimaryPassword : copy.primaryPassword}</Typo.Caption>
        <Input id={primaryId} type="password" autoComplete="off" aria-label={copy.primaryPassword} onKeyDown={event => { if (event.key === "Enter") submitPrimary(); }} />
        <ButtonContainer size="sm"><Button size="sm" disabled={flow.busy} onClick={submitPrimary}>{copy.run}</Button></ButtonContainer>
      </Stack> : flow.error ? <Stack gap="sm" role="alert">
        <Typo.Caption>{flow.error === "browser_locked" ? copy.closeBrowser : copy.failed}</Typo.Caption>
        <ButtonContainer size="sm"><Button size="sm" variant="outline" disabled={flow.busy} onClick={() => void flow.run(flow.selected)}>{copy.retry}</Button></ButtonContainer>
      </Stack> : null}
  </>;
}
