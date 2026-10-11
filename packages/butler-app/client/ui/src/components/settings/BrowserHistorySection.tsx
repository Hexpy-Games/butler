import { useState } from "react";
import { appCopy } from "@/app/copy";
import { Button, ButtonContainer, SettingsSection } from "@/butler-ds";
import { openHistory } from "../browser/historyApi";
import { HistoryClearDialog } from "../browser/HistoryClearDialog";
export function BrowserHistorySection() {
  const [clear, setClear] = useState(false);
  return <SettingsSection id="browser-history" kind="form" title={appCopy.browser.history.title}>
    <ButtonContainer size="sm" justify="end" data-setting-id="browser-history">
      <Button size="sm" variant="ghost" onClick={() => openHistory("settings")}>{appCopy.browser.view}</Button>
      <Button size="sm" variant="ghost" onClick={() => setClear(true)}>{appCopy.browser.history.erase}</Button>
    </ButtonContainer>{clear && <HistoryClearDialog onClose={() => setClear(false)} />}
  </SettingsSection>;
}
