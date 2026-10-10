import { useEffect, useState } from "react";
import { apiErrorCode } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { Button, ButtonContainer, SettingsField, SettingsSection, Stack, Tooltip, Typo } from "@/butler-ds";
import { SettingsSelect } from "./SettingsSelect";
import { listImportSources, pickImportFile, previewImport, runImport, type ImportRequest, type ImportSource } from "./signInsApi";

const FILE = "file";

/** Settings → Security → import bookmarks and passwords from another browser. Counts only, never values. */
export function SecurityBrowserImportSection({ keychain, onImported }: { keychain: boolean; onImported: () => void }) {
  const copy = appCopy.settings.browserImport;
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [source, setSource] = useState(FILE);
  const [bookmarks, setBookmarks] = useState<{ request: ImportRequest; text: string } | null>(null);
  const [passwords, setPasswords] = useState<{ request: ImportRequest; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void listImportSources().then(view => { if (live) { setSources(view.sources); if (view.sources[0]) setSource(view.sources[0].key); } })
      .catch(() => { if (live) setSources([]); });
    return () => { live = false; };
  }, []);

  async function step<T>(work: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    try { return await work(); } catch (error) {
      notifyError(error, apiErrorCode(error) === "full_disk_access_required" ? copy.fullDiskAccess : copy.failed);
      return null;
    } finally { setBusy(false); }
  }
  async function previewBookmarks() {
    let request: ImportRequest = { kind: "bookmarks", source };
    if (source === FILE) {
      const file = await pickImportFile("bookmarks");
      if (!file) return;
      request = { kind: "bookmarks", path: file.path };
    }
    const counts = await step(() => previewImport(request));
    if (counts) setBookmarks({ request, text: copy.bookmarkCount(counts.bookmarks ?? 0, counts.folders ?? 0) });
  }
  async function previewPasswords() {
    const file = await pickImportFile("passwords");
    if (!file) return;
    const request: ImportRequest = { kind: "passwords", path: file.path };
    const counts = await step(() => previewImport(request));
    if (counts) setPasswords({ request, text: copy.passwordCount(counts.passwords ?? 0, counts.sites ?? 0) });
  }
  async function run(kind: "bookmarks" | "passwords") {
    const preview = kind === "bookmarks" ? bookmarks : passwords;
    if (!preview) return;
    const counts = await step(() => runImport(preview.request));
    if (!counts) return;
    const skipped = (counts.existing ?? 0) + (counts.skipped ?? 0) + (counts.invalid ?? 0);
    notifyStatus(copy.imported((counts.imported ?? 0) + (counts.updated ?? 0), skipped), { tone: "ok" });
    if (kind === "passwords") notifyStatus(copy.deleteCsv, { tone: "muted" });
    if (kind === "bookmarks") setBookmarks(null); else { setPasswords(null); onImported(); }
  }

  const options = [...(sources ?? []).map(item => ({ value: item.key, label: `${item.browser[0]!.toUpperCase()}${item.browser.slice(1)} · ${item.name}` })),
    { value: FILE, label: copy.htmlFile }];
  return (
    <SettingsSection id="browser-import" kind="form" title={appCopy.settings.pageSections.browserImport}
      state={sources === null ? "loading" : "ready"}>
      <SettingsSelect settingId="browser-import-bookmarks" label={copy.bookmarks} value={source}
        onChange={(value) => { setSource(value); setBookmarks(null); }} options={options}
        action={(
          <ButtonContainer size="sm">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void previewBookmarks()}>{source === FILE ? copy.chooseFile : copy.preview}</Button>
            <Button size="sm" disabled={busy || !bookmarks} onClick={() => void run("bookmarks")}>{copy.run}</Button>
          </ButtonContainer>
        )} />
      {bookmarks && <Typo.Caption tone="secondary" data-test-class="import-bookmarks-preview">{bookmarks.text}</Typo.Caption>}
      <SettingsField settingId="browser-import-passwords" label={copy.passwords} description={copy.csvFile}
        control={(
          <Stack align="row" gap="sm" cross="center" wrap>
            <Tooltip label={keychain ? copy.chooseFile : copy.needsKeychain}>
              <Button size="sm" variant="outline" disabled={busy || !keychain} onClick={() => void previewPasswords()}>{copy.chooseFile}</Button>
            </Tooltip>
            <Button size="sm" disabled={busy || !passwords || !keychain} onClick={() => void run("passwords")}>{copy.run}</Button>
          </Stack>
        )} />
      {passwords && <Typo.Caption tone="secondary" data-test-class="import-passwords-preview">{passwords.text}</Typo.Caption>}
    </SettingsSection>
  );
}
