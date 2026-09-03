import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { normalizeSettingsSectionId } from "@/app/utils.ts";
import type { SettingsSectionId } from "@/app/types.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsDetailContent } from "./SettingsDetailContent";
import { SettingsDetailHeader } from "./SettingsDetailHeader";
import { ModelSettingsTitle } from "./ModelSettingsTitle";
import { SettingsSidebar } from "./SettingsSidebar";
import { createSettingsSectionGroups } from "./settingsSections";
import { useDeveloperLogsAvailability } from "./useDeveloperLogsAvailability";
import { useCompactSettingsPaneEntry } from "./useCompactSettingsPaneEntry";
import { ArrowLeft, IconButton, SettingsShell } from "@/butler-ds";

interface SettingsViewProps {
  initialSection?: SettingsSectionId | string;
  onClose?: () => void;
  isActive?: boolean;
}
export function SettingsView({ initialSection, onClose, isActive = false }: SettingsViewProps = {}) {
  const [compactPane, setCompactPane] = useState<"master" | "detail">("master");
  const settings = useButlerStore((state) => state.settings);
  const closeSettings = useButlerStore((state) => state.closeSettings);
  const setView = useButlerStore((state) => state.setView);
  const storeView = useButlerStore((state) => state.view);

  const activeSection = useSettingsUIStore((state) => state.activeSection);
  const setActiveSection = useSettingsUIStore((state) => state.setActiveSection);
  const modelRoute = useSettingsUIStore((state) => state.modelRoute);
  const backModelRoute = useSettingsUIStore((state) => state.backModelRoute);
  const resetModelRoute = useSettingsUIStore((state) => state.resetModelRoute);
  const localMessage = useSettingsUIStore((state) => state.localMessage);
  const setLocalMessage = useSettingsUIStore((state) => state.setLocalMessage);
  const initialize = useSettingsUIStore((state) => state.initialize);

  const closeView = onClose ?? closeSettings;

  useEffect(() => {
    const section =
      storeView.kind === "settings"
        ? storeView.section
        : (initialSection ?? "general");
    initialize(settings, normalizeSettingsSectionId(section));
  }, [settings, initialSection, storeView, initialize]);

  useCompactSettingsPaneEntry({
    initialSection,
    isActive,
    setCompactPane,
    view: storeView,
  });

  useEffect(() => {
    if (isActive) setLocalMessage(null);
  }, [isActive, setLocalMessage]);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeView();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeView]);

  const settingsCopy = appCopy.settings;
  const developerModeEnabled = useDeveloperLogsAvailability(settings.diagnostics_enabled === true);
  const sectionGroups = createSettingsSectionGroups(
    settingsCopy,
    developerModeEnabled,
  );
  const sections = sectionGroups.flatMap((group) => group.sections);
  const activeDescriptor = sections.find((item) => item.id === activeSection);
  const title = activeDescriptor?.label ?? settingsCopy.title;

  const changeSection = (section: SettingsSectionId) => {
    setLocalMessage(null);
    if (!setActiveSection(section)) return;
    setCompactPane("detail");
    if (storeView.kind === "settings") {
      setView({ kind: "settings", section });
    }
  };

  useEffect(() => {
    if (activeSection !== "logs" || developerModeEnabled) return;
    setActiveSection("about");
    if (storeView.kind === "settings") {
      setView({ kind: "settings", section: "about" });
    }
  }, [
    activeSection,
    developerModeEnabled,
    setActiveSection,
    setView,
    storeView.kind,
  ]);
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
      compactPane={compactPane}
      detailNavigation={
        <IconButton
          label={settingsCopy.back}
          onClick={() => setCompactPane("master")}
        >
          <ArrowLeft size={18} />
        </IconButton>
      }
      sidebar={
        <SettingsSidebar
          sectionGroups={sectionGroups}
          activeSection={activeSection}
          backLabel={settingsCopy.back}
          onClose={closeView}
          onSectionChange={changeSection}
          isActive={isActive}
        />
      }
      detailHeader={
        <SettingsDetailHeader
          title={title}
          description={activeDescriptor?.description}
          secondary={titleSecondary}
          localMessage={localMessage}
        />
      }
      detail={
        <SettingsDetailContent
          activeSection={activeSection}
          developerModeEnabled={developerModeEnabled}
        />
      }
    />
  );
}
