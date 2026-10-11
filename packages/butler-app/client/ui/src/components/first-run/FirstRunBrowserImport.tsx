import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy";
import { Globe2, SettingsPage, SetupWizardStepAction } from "@/butler-ds";
import { SecurityBrowserImportSection } from "../settings/SecurityBrowserImportSection";
import { listSignIns } from "../settings/signInsApi";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** Optional; entering or skipping never changes the connection or consent. */
export function FirstRunBrowserImport({ flow }: { flow: FirstRunFlow }) {
  const [keychain, setKeychain] = useState(false);
  useEffect(() => {
    let live = true;
    void listSignIns().then(view => { if (live) setKeychain(view.available); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const copy = appCopy.settings.browserImport;
  return <FirstRunStepCard flow={flow} icon={<Globe2 size="lg" />} title={appCopy.settings.pageSections.browserImport}
    onBack={flow.backToConsent} actions={<>
      <SetupWizardStepAction onClick={flow.skipImport}>{copy.skip}</SetupWizardStepAction>
      <SetupWizardStepAction forward onClick={flow.skipImport}>{copy.continue}</SetupWizardStepAction>
    </>}>
    <SettingsPage><SecurityBrowserImportSection keychain={keychain} showTitle={false} onImported={() => {}} /></SettingsPage>
  </FirstRunStepCard>;
}
