import { useAppLocale } from "@/app/copy.ts";
import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { normalizeSettingsSectionId } from "@/app/utils.ts";
import type { SettingsSectionId } from "@/app/types.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsDetailContent } from "./SettingsDetailContent";
import { SettingsDetailHeader } from "./SettingsDetailHeader";
import { ModelSettingsTitle } from "./ModelSettingsTitle";
import { LogTraceTitle } from "./logs/LogTraceTitle";
import { traceTargetKey } from "./logs/traceApi";
import { useLogTraceRoute } from "@/stores/logTraceStore.ts";
import { SettingsSidebar } from "./SettingsSidebar";
import { createSettingsSectionGroups } from "./settingsSections";
import { useDeveloperMode } from "@/hooks/useDeveloperMode.ts";
import { useCompactSettingsPaneEntry } from "./useCompactSettingsPaneEntry";
import { ArrowLeft, IconButton, SettingsShell } from "@/butler-ds";

interface SettingsViewProps {
  initialSection?: SettingsSectionId | string;
  onClose?: () => void;
  isActive?: boolean;
}
export function SettingsView({ initialSection, onClose, isActive = false }: SettingsViewProps = {}) {
  useAppLocale();
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
  const setLocalMessage = useSettingsUIStore((state) => state.setLocalMessage);
  const initialize = useSettingsUIStore((state) => state.initialize);
  const { target: traceTarget, close: closeTrace } = useLogTraceRoute();

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
      if (event.key === "Escape" && !event.defaultPrevented) closeView();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeView]);

  const settingsCopy = appCopy.settings;
  const developerModeEnabled = useDeveloperMode();
  const sectionGroups = createSettingsSectionGroups(
    settingsCopy,
    developerModeEnabled,
  );
  const sections = sectionGroups.flatMap((group) => group.sections);
  const activeDescriptor = sections.find((item) => item.id === activeSection);
  const title = activeDescriptor?.label ?? settingsCopy.title;

  const changeSection = async (section: SettingsSectionId) => {
    setLocalMessage(null);
    if (!await setActiveSection(section)) return;
    if (section === "logs") closeTrace(); // the sidebar's 로그 is the log list
    setCompactPane("detail");
    if (storeView.kind === "settings") {
      setView({ kind: "settings", section });
    }
  };

  useEffect(() => {
    if (activeSection !== "logs" || developerModeEnabled) return;
    void setActiveSection("about").then((changed) => {
      if (changed && storeView.kind === "settings") {
        setView({ kind: "settings", section: "about" });
      }
    });
  }, [
    activeSection,
    developerModeEnabled,
    setActiveSection,
    setView,
    storeView.kind,
  ]);
  const logTrace = activeSection === "logs" && traceTarget ? traceTargetKey(traceTarget) : null;
  const titleSecondary =
    activeSection === "models" ? (
      <ModelSettingsTitle
        modelRoute={modelRoute}
        onBack={backModelRoute}
        onRoot={resetModelRoute}
        onManagement={backModelRoute}
      />
    ) : logTrace ? <LogTraceTitle onLogs={closeTrace} /> : undefined;
  const pageOrder = sections.findIndex((item) => item.id === activeSection);

  return (
    <SettingsShell
      active={isActive}
      compactPane={compactPane}
      pageTitle={title}
      pageDescription={activeDescriptor?.description}
      pageKey={logTrace ? `logs/${logTrace}` : activeSection}
      pageOrder={logTrace ? pageOrder + 0.5 : pageOrder}
      detailNavigation={
        <IconButton
          label={settingsCopy.back}
          onClick={() => setCompactPane("master")}
        >
          <ArrowLeft size="lg" />
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
