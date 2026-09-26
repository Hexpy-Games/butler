import { appCopy, useAppLocale } from "@/app/copy.ts";
import { SettingsSection } from "./SettingsFormComponents";
import { ButlerModelFields } from "./ButlerModelFields";
import { FallbackConsolidationFields } from "./FallbackConsolidationFields";
import { PermissionsFields } from "./PermissionsFields";

/** The three Butler model sections, for surfaces outside the Models page (first run). */
export function ButlerModelSettings() {
  useAppLocale();
  const sections = appCopy.settings.pageSections;
  return (
    <>
      <SettingsSection id="butler-model" kind="form" title={sections.butlerModel}>
        <ButlerModelFields />
      </SettingsSection>
      <SettingsSection
        id="fallback-consolidation"
        kind="form"
        title={sections.fallbackConsolidation}
        description={appCopy.settings.pageSectionDescriptions.fallbackConsolidation}
      >
        <FallbackConsolidationFields />
      </SettingsSection>
      <SettingsSection id="permissions" kind="form" title={sections.permissions}>
        <PermissionsFields />
      </SettingsSection>
    </>
  );
}
