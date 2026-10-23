import { useState } from "react";
import { appCopy } from "@/app/copy";
import { confirmAction } from "@/app/confirmation";
import { notifyStatus } from "@/app/notifications";
import { Button, ListRow, SettingsSection, Stack, Tooltip } from "@/butler-ds";
import { canOpenHandoffTab } from "../browser/browserHandoff";

/** Clears the in-app browser's cookies, site data and cache. Saved sign-ins live in the keychain and stay. */
export function BrowserSiteDataSection() {
  const copy = appCopy.browser.siteData;
  const [busy, setBusy] = useState(false);
  const reason = canOpenHandoffTab() ? undefined : copy.desktopOnly;
  async function clear() {
    if (!await confirmAction(copy.confirmMessage, { title: copy.confirmTitle, confirmLabel: copy.clear, destructive: true,
      details: [{ label: copy.items, text: copy.itemList }], note: copy.kept })) return;
    setBusy(true);
    try { await window.butlerBrowser?.call("clear-site-data"); notifyStatus(copy.cleared, { tone: "ok" }); }
    catch { notifyStatus(copy.failed, { tone: "error" }); }
    finally { setBusy(false); }
  }
  return <SettingsSection id="browser-site-data" kind="form" title={copy.title}>
    <Stack align="row" cross="center" gap="sm" data-setting-id="browser-site-data">
      <Stack grow minWidth="0"><ListRow title={copy.label} description={copy.description} /></Stack>
      <Tooltip label={reason}>
        <Button type="button" size="sm" variant="outline" disabled={busy || Boolean(reason)}
          aria-label={reason ? `${copy.clear}. ${reason}` : undefined} onClick={() => void clear()}>{copy.clear}</Button>
      </Tooltip>
    </Stack>
  </SettingsSection>;
}
