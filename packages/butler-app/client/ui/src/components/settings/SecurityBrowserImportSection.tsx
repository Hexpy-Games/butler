import { useState } from "react";
import { appCopy } from "@/app/copy";
import { Button, SettingsActionField, SettingsSection } from "@/butler-ds";
import { BrowserImportDialog } from "./BrowserImportDialog";

/** Settings → Browser, last section: one button that opens the import dialog. Passwords stay out of view state. */
export function SecurityBrowserImportSection({ keychain, onImported }: { keychain: boolean; onImported: () => void }) {
  const copy = appCopy.settings.browserImport;
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection id="browser-import" kind="form" title={appCopy.settings.pageSections.browserImport}>
      <SettingsActionField settingId="browser-import-data" label={copy.dataLabel} description={copy.purpose}
        action={<Button size="sm" variant="outline" data-test-class="browser-import-open" onClick={() => setOpen(true)}>{copy.open}</Button>} />
      <BrowserImportDialog open={open} onOpenChange={setOpen} keychain={keychain} onImported={onImported} />
    </SettingsSection>
  );
}
