import { useId, useState } from "react";
import { appCopy } from "@/app/copy";
import { Button, ButtonContainer, CheckIcon, ChoiceCard, DisclosureRow, FileText, Globe2, IconSlot, Input, SettingsSection, Spinner, Square, Stack, Tooltip, Typo } from "@/butler-ds";
import { openImportDiskAccess } from "./signInsApi";
import { useBrowserImport } from "./useBrowserImport";

const BRANDS: Record<string, string> = { chrome: "Chrome", chromium: "Chromium", edge: "Edge", brave: "Brave", arc: "Arc", whale: "Whale", firefox: "Firefox", zen: "Zen", safari: "Safari" };

/** Settings → Browser, shared by the optional first-run step. Passwords stay out of view state. */
export function SecurityBrowserImportSection({ keychain, onImported }: { keychain: boolean; onImported: () => void }) {
  const copy = appCopy.settings.browserImport;
  const flow = useBrowserImport(onImported);
  const [expanded, setExpanded] = useState(false);
  const primaryId = useId();
  const [diskHint, setDiskHint] = useState(false);
  const blocked = flow.busy || !!flow.exportId || (!flow.bookmarks && !flow.passwords) || (flow.passwords && !keychain);
  const permission = flow.error === "full_disk_access_required";
  const needsPrimary = flow.error === "primary_password_required" || flow.error === "incorrect_primary_password";
  function submitPrimary() {
    const input = document.getElementById(primaryId) as HTMLInputElement | null;
    const value = input?.value ?? "";
    if (input) input.value = "";
    void flow.run(flow.selected, value);
  }
  return (
    <SettingsSection id="browser-import" kind="form" title={appCopy.settings.pageSections.browserImport} state={flow.sources === null ? "loading" : "ready"}>
      <Stack gap="sm" data-test-class="browser-import-flow">
        {!flow.result ? <>
          <DisclosureRow title={copy.chooseItems} open={expanded} onToggle={() => setExpanded(value => !value)}>
            <ButtonContainer size="sm">
              <Button size="sm" variant="ghost" role="checkbox" aria-checked={flow.bookmarks} disabled={flow.busy} iconStart={flow.bookmarks ? <CheckIcon size="sm" /> : <Square size="sm" />} onClick={() => flow.setBookmarks(!flow.bookmarks)}>{copy.bookmarks}</Button>
              <Tooltip label={keychain ? copy.passwords : copy.needsKeychain}>
                <Button size="sm" variant="ghost" role="checkbox" aria-checked={flow.passwords} disabled={flow.busy} iconStart={flow.passwords ? <CheckIcon size="sm" /> : <Square size="sm" />} onClick={() => flow.setPasswords(!flow.passwords)}>{copy.passwords}</Button>
              </Tooltip>
            </ButtonContainer>
          </DisclosureRow>
          {flow.sources?.map(source => <Tooltip key={source.key} label={!keychain && flow.passwords ? copy.needsKeychain : copy.run}>
            <ChoiceCard icon={source.browser === "whale" || !BRANDS[source.browser] ? <Globe2 size="lg" /> : <IconSlot size="lg"><img src={`/browser-icons/${source.browser}.svg`} width={20} height={20} alt="" /></IconSlot>} title={BRANDS[source.browser] ?? source.browser} description={source.name}
              meta={source.permission === "denied" ? copy.pickFolder : copy.run} data-import-source={source.key}
              state={flow.busy && flow.selected === source.key ? "loading" : blocked ? "disabled" : "default"}
              onClick={() => void flow.run(source.key)} />
          </Tooltip>)}
          {!flow.sources?.length ? <Typo.Caption tone="secondary">{copy.noSources}</Typo.Caption> : null}
          <ButtonContainer size="sm">
            <Tooltip label={!keychain && flow.passwords ? copy.needsKeychain : copy.chooseFile}>
              <Button size="sm" variant="ghost" iconStart={<FileText size="sm" />} disabled={blocked} onClick={() => void flow.run("file")}>{copy.chooseFile}</Button>
            </Tooltip>
          </ButtonContainer>
        </> : null}
        {flow.busy ? <Stack align="row" gap="sm" cross="center" role="status" data-test-class="import-progress"><Spinner /><Typo.Text>{copy.importing}</Typo.Text></Stack> : null}
        {flow.result ? <Stack gap="sm" role="status" data-test-class="import-result">
          <Typo.Text>{flow.undone ? copy.undone : copy.result(flow.result.bookmarks, flow.result.passwords, flow.result.updated)}</Typo.Text>
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
      </Stack>
    </SettingsSection>
  );
}
