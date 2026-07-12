import type { SettingsSectionId } from "@/app/types.ts";
import { AboutSettings } from "./AboutSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { ArchivesSettings } from "./ArchivesSettings";
import { DeveloperLogsSettings } from "./DeveloperLogsSettings";
import { GeneralSettings } from "./GeneralSettings";
import { McpSettings } from "./McpSettings";
import { ModelsSettings } from "./ModelsSettings";
import { PersonalizationSettings } from "./PersonalizationSettings";
import { PrivacySettings } from "./PrivacySettings";
import { ServerSettings } from "./ServerSettings";
import { SkillsSettings } from "./SkillsSettings";
import { SystemEventsSettings } from "./SystemEventsSettings";
import { UpdatesSettings } from "./UpdatesSettings";
import { UsageSettings } from "./UsageSettings";

export function SettingsDetailContent({
  activeSection,
  developerModeEnabled,
}: {
  activeSection: SettingsSectionId;
  developerModeEnabled: boolean;
}) {
  return (
    <>
      {activeSection === "general" && <GeneralSettings />}
      {activeSection === "models" && <ModelsSettings />}
      {activeSection === "appearance" && <AppearanceSettings />}
      {activeSection === "server" && <ServerSettings />}
      {activeSection === "updates" && <UpdatesSettings />}
      {activeSection === "mcp" && <McpSettings />}
      {activeSection === "skills" && <SkillsSettings />}
      {activeSection === "usage" && <UsageSettings />}
      {activeSection === "logs" && developerModeEnabled && (
        <DeveloperLogsSettings />
      )}
      {activeSection === "privacy" && <PrivacySettings />}
      {activeSection === "system" && <SystemEventsSettings />}
      {activeSection === "archives" && <ArchivesSettings />}
      {activeSection === "about" && <AboutSettings />}
      {activeSection === "personalization" && <PersonalizationSettings />}
    </>
  );
}
