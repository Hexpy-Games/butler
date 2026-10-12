import { useId, useState } from "react";
import { appCopy } from "@/app/copy";
import { Button, ButtonContainer, Input, SettingsSection, Spinner, Stack, Typo } from "@/butler-ds";
import { BrowserImportItems, BrowserImportSources } from "./BrowserImportSources";
import { openImportDiskAccess } from "./signInsApi";
import { useBrowserImport } from "./useBrowserImport";

/** Settings → Browser, shared by the optional first-run step (which shows its own title). Passwords stay out of view state. */
export function SecurityBrowserImportSection({ keychain, onImported, showTitle = true }: { keychain: boolean; onImported: () => void; showTitle?: boolean }) {
  const copy = appCopy.settings.browserImport;
  const flow = useBrowserImport(onImported);
  const primaryId = useId();
  const [diskHint, setDiskHint] = useState(false);
  const blocked = flow.busy || !!flow.exportId || (!flow.bookmarks && !flow.passwords && !flow.history) || (flow.passwords && !keychain);
  const permission = flow.error === "full_disk_access_required";
  const needsPrimary = flow.error === "primary_password_required" || flow.error === "incorrect_primary_password";
  function submitPrimary() {
    const input = document.getElementById(primaryId) as HTMLInputElement | null;
    const value = input?.value ?? "";
    if (input) input.value = "";
    void flow.run(flow.selected, value);
  }
  return (
    <SettingsSection id="browser-import" kind="list" title={showTitle ? appCopy.settings.pageSections.browserImport : undefined}
      description={showTitle ? copy.purpose : undefined} state={flow.sources === null ? "loading" : "ready"}>
      {!flow.result ? <>
        <BrowserImportItems flow={flow} keychain={keychain} />
        <BrowserImportSources flow={flow} keychain={keychain} blocked={blocked} />
      </> : null}
      {flow.busy ? <Stack align="row" gap="sm" cross="center" role="status" data-test-class="import-progress"><Spinner /><Typo.Text>{copy.importing}</Typo.Text></Stack> : null}
      {flow.result ? <Stack gap="sm" role="status" data-test-class="import-result">
        <Typo.Text>{flow.undone ? copy.undone : copy.result(flow.result.bookmarks, flow.result.passwords, flow.result.updated, flow.result.history ?? 0, flow.result.invalid ?? 0)}</Typo.Text>
        <ButtonContainer size="sm">
          <Button size="sm" variant="outline" disabled={flow.busy || flow.undone} onClick={() => void flow.undo()}>{copy.undo}</Button>
          <Button size="sm" variant="ghost" disabled={flow.busy} onClick={() => void flow.more()}>{copy.more}</Button>
          {flow.result.needs_csv && !flow.exportId && !flow.result.export_id ? <Button size="sm" variant="outline" disabled={flow.busy} onClick={() => void flow.resumeExport()}>{copy.exportPasswords}</Button> : null}
          {flow.result.export_id ? <Button size="sm" variant="outline" disabled={flow.busy} onClick={() => void flow.removeCsv()}>{copy.deleteCsv}</Button> : null}
        </ButtonContainer>
      </Stack> : null}
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
    </SettingsSection>
  );
}
