import { useEffect, useMemo } from "react";
import { WindowChromeLayer } from "@/components/layout/Chrome.tsx";
import { RightPanelOverlayTitlebar } from "@/components/layout/RightPanelOverlayTitlebar.tsx";
import { Sidebar } from "@/components/layout/Sidebar.tsx";
import { Titlebar } from "@/components/layout/Titlebar.tsx";
import { Conversation } from "@/components/conversation/Conversation.tsx";
import { Inspector } from "@/components/inspector/Inspector.tsx";
import { ProjectDashboardView } from "@/components/management/ProjectDashboardView.tsx";
import { SettingsView } from "@/components/settings/SettingsView.tsx";
import { chromeEnvironmentClassName } from "@/app/chromeEnvironment.ts";
import { EMPTY_SETTINGS } from "@/app/constants.ts";
import { platformClassName } from "@/app/nativeNotifications.ts";
import {
  HARNESS_MODEL_CATALOG,
  HARNESS_MESSAGES,
  HARNESS_NAVIGATION,
  HARNESS_PROJECT_DASHBOARD,
  HARNESS_SUMMARY,
} from "@/app/fixtures.ts";
import { appThemeClasses, isDraftChatId, projectDraftId } from "@/app/utils.ts";
import { useButlerStore } from "@/app/store.ts";
import {
  LEFT_PANEL_MAX_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  usePanelResize,
} from "@/hooks/usePanelResize.ts";
import { useNarrowRightPanelAutoCollapse } from "@/hooks/useNarrowRightPanelAutoCollapse.ts";
import { usePortalThemeClasses } from "@/hooks/usePortalThemeClasses.ts";
import { useSystemThemePreference } from "@/hooks/useSystemThemePreference.ts";
import shellStyles from "./Shell.module.css";

void shellStyles;

export function VisualHarness() {
  const leftOpen = useButlerStore((state) => state.leftOpen);
  const setLeftOpen = useButlerStore((state) => state.setLeftOpen);
  const rightOpen = useButlerStore((state) => state.rightOpen);
  const setRightOpen = useButlerStore((state) => state.setRightOpen);
  const view = useButlerStore((state) => state.view);
  const setView = useButlerStore((state) => state.setView);
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const setActiveChatId = useButlerStore((state) => state.setActiveChatId);
  const setRightTab = useButlerStore((state) => state.setRightTab);
  const setNavigation = useButlerStore((state) => state.setNavigation);
  const setMessages = useButlerStore((state) => state.setMessages);
  const setSettings = useButlerStore((state) => state.setSettings);
  const setModelCatalog = useButlerStore((state) => state.setModelCatalog);
  const setSummary = useButlerStore((state) => state.setSummary);
  const setStatus = useButlerStore((state) => state.setStatus);
  const visualTheme =
    new URLSearchParams(window.location.search).get("theme") === "dark"
      ? "dark"
      : EMPTY_SETTINGS.appearance_theme;
  const harnessSettings = useMemo(
    () =>
      visualTheme === EMPTY_SETTINGS.appearance_theme
        ? EMPTY_SETTINGS
        : { ...EMPTY_SETTINGS, appearance_theme: visualTheme },
    [visualTheme],
  );
  const systemPrefersDark = useSystemThemePreference();
  usePortalThemeClasses(harnessSettings, systemPrefersDark);
  const rightAvailable =
    view.kind === "session" && !isDraftChatId(activeChatId);
  const effectiveRightOpen = rightOpen && rightAvailable;
  const isSettingsView = view.kind === "settings";
  const newChatActive =
    view.kind === "session" && isDraftChatId(activeChatId);
  const {
    beginPanelResize,
    handlePanelResizeKeyDown,
    leftPanelWidth,
    panelStyle,
    rightPanelWidth,
    resizingPanel,
  } = usePanelResize({
    setLeftOpen,
  });
  useNarrowRightPanelAutoCollapse({
    rightOpen: effectiveRightOpen,
    setLeftOpen,
  });
  useEffect(() => {
    setLeftOpen(false);
    setRightOpen(true);
    setRightTab("summary");
    setView({ kind: "session" });
    setActiveChatId("butler-client");
    setNavigation(HARNESS_NAVIGATION);
    setMessages(HARNESS_MESSAGES);
    setSettings(harnessSettings);
    setModelCatalog(HARNESS_MODEL_CATALOG);
    setSummary(HARNESS_SUMMARY);
    setStatus({ label: "ready", tone: "ok" });
  }, [
    harnessSettings,
    setActiveChatId,
    setLeftOpen,
    setModelCatalog,
    setMessages,
    setNavigation,
    setRightOpen,
    setRightTab,
    setSettings,
    setStatus,
    setView,
    setSummary,
  ]);
  return (
    <div
      className={`${shellStyles.moduleScope} mac-window visual-harness ${chromeEnvironmentClassName()} ${platformClassName()} ${appThemeClasses(harnessSettings, systemPrefersDark)} ${leftOpen ? "" : "left-collapsed"} ${effectiveRightOpen ? "right-open" : ""} ${isSettingsView ? "settings-active" : ""} ${newChatActive ? "new-chat-active" : ""} ${resizingPanel ? "panel-resizing" : ""}`}
      data-test-class="mac-window visual-harness"
      style={panelStyle}
    >
      {!isSettingsView && (
        <WindowChromeLayer
          leftOpen={leftOpen}
          onToggle={() => setLeftOpen((value) => !value)}
        />
      )}
      {!isSettingsView && effectiveRightOpen && <RightPanelOverlayTitlebar />}
      {isSettingsView ? (
        <SettingsView
          initialSection="general"
          onClose={() => setView({ kind: "session" })}
          isActive={isSettingsView}
        />
      ) : (
        <>
          <div
            className="sidebar-slot"
            data-test-class="sidebar-slot"
            id="butler-left-sidebar"
          >
            <Sidebar />
          </div>
          <main className="workspace" data-test-class="workspace">
            <Titlebar />
            {view.kind === "project-dashboard" ? (
              <ProjectDashboardView
                initialDashboard={HARNESS_PROJECT_DASHBOARD}
                project={HARNESS_NAVIGATION.projects.find(
                  (project) => project.id === view.projectId,
                )}
                onOpenSession={(chatId) => {
                  setActiveChatId(chatId);
                  setView({ kind: "session" });
                }}
                onNewProjectChat={(projectId) => {
                  setActiveChatId(projectDraftId(projectId));
                  setView({ kind: "session" });
                }}
              />
            ) : (
              <Conversation />
            )}
          </main>
        </>
      )}
      {!isSettingsView && leftOpen && (
        <div
          aria-label="Resize left sidebar"
          aria-orientation="vertical"
          aria-controls="butler-left-sidebar"
          aria-valuemax={LEFT_PANEL_MAX_WIDTH}
          aria-valuemin={LEFT_PANEL_MIN_WIDTH}
          aria-valuenow={leftPanelWidth}
          className="panel-resize-handle left-panel-resize-handle no-drag"
          data-test-class="panel-resize-handle left-panel-resize-handle"
          role="separator"
          tabIndex={0}
          onKeyDown={(event) => handlePanelResizeKeyDown("left", event)}
          onPointerDown={(event) => beginPanelResize("left", event)}
        />
      )}
      {!isSettingsView && rightAvailable && (
        <div className="right-panel-slot" data-test-class="right-panel-slot">
          <Inspector id="butler-right-inspector" />
        </div>
      )}
      {!isSettingsView && effectiveRightOpen && (
        <div
          aria-label="Resize right panel"
          aria-orientation="vertical"
          aria-controls="butler-right-inspector"
          aria-valuemax={RIGHT_PANEL_MAX_WIDTH}
          aria-valuemin={RIGHT_PANEL_MIN_WIDTH}
          aria-valuenow={rightPanelWidth}
          className="panel-resize-handle right-panel-resize-handle no-drag"
          data-test-class="panel-resize-handle right-panel-resize-handle"
          role="separator"
          tabIndex={0}
          onKeyDown={(event) => handlePanelResizeKeyDown("right", event)}
          onPointerDown={(event) => beginPanelResize("right", event)}
        />
      )}
    </div>
  );
}
