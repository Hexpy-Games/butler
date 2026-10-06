import { appCopy, useAppLocale } from "@/app/copy.ts";
import { SettingsSection } from "./SettingsFormComponents";
import { BackupModelsSummary } from "./BackupModelsSummary";
import { ButlerModelFields } from "./ButlerModelFields";

/**
 * The everyday Butler model sections, for surfaces outside the Models page
 * (first run). Memory cleanup and worker profiles stay on the Models page.
 */
export function ButlerModelSettings() {
  useAppLocale();
  const sections = appCopy.settings.pageSections;
  return (
    <>
      <SettingsSection id="butler-model" kind="form" title={sections.butlerModel}>
        <ButlerModelFields />
      </SettingsSection>
      <SettingsSection id="backup-models" kind="form" title={sections.backupModels}>
        <BackupModelsSummary />
      </SettingsSection>
    </>
  );
}
