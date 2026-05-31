import { useEffect } from "react";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { normalizeSettingsSectionId } from "@/app/utils.ts";
import type { SettingsSectionId } from "@/app/types.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { AboutSettings } from "./AboutSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { ArchivesSettings } from "./ArchivesSettings";
import { GeneralSettings } from "./GeneralSettings";
import { McpSettings } from "./McpSettings";
import { ModelsSettings } from "./ModelsSettings";
import { PersonalizationSettings } from "./PersonalizationSettings";
import { PrivacySettings } from "./PrivacySettings";
import { ServerSettings } from "./ServerSettings";
import { SkillsSettings } from "./SkillsSettings";
import { SystemEventsSettings } from "./SystemEventsSettings";
import { UsageSettings } from "./UsageSettings";
import { UpdatesSettings } from "./UpdatesSettings";
import { SettingsDetailHeader } from "./SettingsDetailHeader";
import { ModelSettingsTitle } from "./ModelSettingsTitle";
import { SettingsSidebar } from "./SettingsSidebar";
import { createSettingsSections } from "./settingsSections";
import { SettingsShell } from "@/butler-ds";

interface SettingsViewProps {
  initialSection?: SettingsSectionId | string;
  onClose?: () => void;
  isActive?: boolean;
}

export function SettingsView({
  initialSection,
  onClose,
  isActive = false,
}: SettingsViewProps = {}) {
  const settings = useButlerStore((state) => state.settings);
  const closeSettings = useButlerStore((state) => state.closeSettings);
  const setView = useButlerStore((state) => state.setView);
  const storeView = useButlerStore((state) => state.view);

  const activeSection = useSettingsUIStore((state) => state.activeSection);
  const setActiveSection = useSettingsUIStore(
    (state) => state.setActiveSection,
  );
  const modelRoute = useSettingsUIStore((state) => state.modelRoute);
  const backModelRoute = useSettingsUIStore((state) => state.backModelRoute);
  const resetModelRoute = useSettingsUIStore((state) => state.resetModelRoute);
  const localMessage = useSettingsUIStore((state) => state.localMessage);
  const setLocalMessage = useSettingsUIStore((state) => state.setLocalMessage);
  const initialize = useSettingsUIStore((state) => state.initialize);

  const closeView = onClose ?? closeSettings;

  // Initialize settings UI store when component mounts or settings change
  useEffect(() => {
    const section =
      storeView.kind === "settings"
        ? storeView.section
        : (initialSection ?? "general");
    initialize(settings, normalizeSettingsSectionId(section));
  }, [settings, initialSection, storeView, initialize]);

  useEffect(() => {
    if (isActive) setLocalMessage(null);
  }, [isActive, setLocalMessage]);

  // Close on Escape key
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeView();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeView]);

  const settingsCopy = appCopy.settings;
  const sections = createSettingsSections(settingsCopy);
  const title =
    sections.find((item) => item.id === activeSection)?.label ??
    settingsCopy.title;

  const changeSection = (section: SettingsSectionId) => {
    setLocalMessage(null);
    if (!setActiveSection(section)) return;
    if (storeView.kind === "settings") {
      setView({ kind: "settings", section });
    }
  };
  const titleNode = title;
  const titleSecondary =
    activeSection === "models" ? (
      <ModelSettingsTitle
        modelRoute={modelRoute}
        onBack={backModelRoute}
        onRoot={resetModelRoute}
        onManagement={backModelRoute}
      />
    ) : undefined;

  return (
    <SettingsShell
      active={isActive}
      sidebar={
        <SettingsSidebar
          sections={sections}
          activeSection={activeSection}
          backLabel={settingsCopy.back}
          onClose={closeView}
          onSectionChange={changeSection}
          isActive={isActive}
        />
      }
      detailHeader={
        <SettingsDetailHeader
          title={titleNode}
          secondary={titleSecondary}
          localMessage={localMessage}
        />
      }
      detail={
        <>
          {activeSection === "general" && <GeneralSettings />}
          {activeSection === "models" && <ModelsSettings />}
          {activeSection === "appearance" && <AppearanceSettings />}
          {activeSection === "server" && <ServerSettings />}
          {activeSection === "updates" && <UpdatesSettings />}
          {activeSection === "mcp" && <McpSettings />}
          {activeSection === "skills" && <SkillsSettings />}
          {activeSection === "usage" && <UsageSettings />}
          {activeSection === "privacy" && <PrivacySettings />}
          {activeSection === "system" && <SystemEventsSettings />}
          {activeSection === "archives" && <ArchivesSettings />}
          {activeSection === "about" && <AboutSettings />}
          {activeSection === "personalization" && <PersonalizationSettings />}
        </>
      }
    />
  );
}
