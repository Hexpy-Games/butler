import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy";
import { Globe2, SettingsPage, SettingsSection, SetupWizardStepAction } from "@/butler-ds";
import { SecurityBrowserImportSection } from "../settings/SecurityBrowserImportSection";
import { listSignIns } from "../settings/signInsApi";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** Optional, after the AI is chosen; entering or skipping never changes the connection or consent. */
export function FirstRunBrowserImport({ flow }: { flow: FirstRunFlow }) {
  const [keychain, setKeychain] = useState(false);
  const ready = flow.readiness.status === "ready";
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void listSignIns().then(view => { if (live) setKeychain(view.available); }).catch(() => {});
    return () => { live = false; };
  }, [ready]);
  const copy = appCopy.settings.browserImport;
  return <FirstRunStepCard flow={flow} icon={<Globe2 size="lg" />} title={appCopy.settings.pageSections.browserImport}
    description={copy.purpose} onBack={flow.backToList} actions={<>
      <SetupWizardStepAction onClick={flow.finishImport}>{copy.skip}</SetupWizardStepAction>
      <SetupWizardStepAction forward onClick={flow.finishImport}>{copy.continue}</SetupWizardStepAction>
    </>}>
    <SettingsPage>{ready
      ? <SecurityBrowserImportSection keychain={keychain} showTitle={false} onImported={() => {}} />
      // Sources load from the Agent; wait for it so detection is not misreported as empty.
      : <SettingsSection id="browser-import" kind="list" state="loading" />}</SettingsPage>
  </FirstRunStepCard>;
}
