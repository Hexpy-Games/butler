import { useState } from "react";
import { WindowChromeLayer } from "@/components/layout/Chrome.tsx";
import { RightPanelOverlayTitlebar } from "@/components/layout/RightPanelOverlayTitlebar.tsx";
import { Sidebar } from "@/components/layout/Sidebar.tsx";
import { Titlebar } from "@/components/layout/Titlebar.tsx";
import { Conversation } from "@/components/conversation/Conversation.tsx";
import { Inspector } from "@/components/inspector/Inspector.tsx";
import { ProjectDashboardView } from "@/components/management/ProjectDashboardView.tsx";
import { AutomationsView } from "@/components/management/AutomationsView.tsx";
import { SettingsView } from "@/components/settings/SettingsView.tsx";
import { CommandPalette } from "@/components/command/CommandPalette.tsx";
import { ProjectRenameDialog } from "@/components/layout/ProjectRenameDialog.tsx";
import { SessionRenameDialog } from "@/components/layout/SessionRenameDialog.tsx";
import { AppToaster } from "@/components/common/AppToaster.tsx";
import { chromeEnvironmentClassName } from "@/app/chromeEnvironment.ts";
import { platformClassName } from "@/app/nativeNotifications.ts";
import { appThemeClasses, isDraftChatId } from "@/app/utils.ts";
import {
  selectEffectiveRightOpen,
  selectIsSettingsView,
  selectRightAvailable,
  useButlerStore,
} from "@/app/store.ts";
import { useAppBootstrap } from "@/hooks/useAppBootstrap.ts";
import { useNativeAppearanceTheme } from "@/hooks/useNativeAppearanceTheme.ts";
import { useNativeShellPreferences } from "@/hooks/useNativeShellPreferences.ts";
import { usePortalThemeClasses } from "@/hooks/usePortalThemeClasses.ts";
import { useSystemThemePreference } from "@/hooks/useSystemThemePreference.ts";
import {
  LEFT_PANEL_MAX_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  usePanelResize,
} from "@/hooks/usePanelResize.ts";
import { useNarrowRightPanelAutoCollapse } from "@/hooks/useNarrowRightPanelAutoCollapse.ts";
import { FirstRunSetup } from "@/components/first-run/FirstRunSetup.tsx";
import { readFirstRunState } from "@/app/firstRunSetup.ts";
import shellStyles from "./Shell.module.css";

void shellStyles;

export function AppShell() {
  const [firstRunState, setFirstRunState] = useState(() =>
    readFirstRunState(
      window.localStorage,
      typeof navigator !== "undefined" ? navigator.languages : [],
    ),
  );
  const openSettings = useButlerStore((state) => state.openSettings);
  if (firstRunState.status !== "complete") {
    return (
      <>
        <FirstRunSetup
          initialState={firstRunState}
          onComplete={(mode, completedState) => {
            setFirstRunState(completedState);
            if (mode === "model-settings") openSettings("models");
          }}
        />
        <AppToaster />
      </>
    );
  }
  return <AppWorkspaceShell />;
}

function AppWorkspaceShell() {
  useAppBootstrap();
  const leftOpen = useButlerStore((state) => state.leftOpen);
  const setLeftOpen = useButlerStore((state) => state.setLeftOpen);
  const view = useButlerStore((state) => state.view);
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const settings = useButlerStore((state) => state.settings);
  const systemPrefersDark = useSystemThemePreference();
  useNativeAppearanceTheme(settings.appearance_theme);
  useNativeShellPreferences(settings);
  usePortalThemeClasses(settings, systemPrefersDark);
  const commandOpen = useButlerStore((state) => state.commandOpen);
  const renameProject = useButlerStore((state) => state.renameProject);
  const renameSession = useButlerStore((state) => state.renameSession);
  const effectiveRightOpen = useButlerStore(selectEffectiveRightOpen);
  const rightAvailable = useButlerStore(selectRightAvailable);
  const isSettingsView = useButlerStore(selectIsSettingsView);
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
    setLeftOpen: (value) => setLeftOpen(value),
  });
  useNarrowRightPanelAutoCollapse({
    rightOpen: effectiveRightOpen,
    setLeftOpen,
  });

  return (
    <div
      className={`${shellStyles.moduleScope} mac-window ${chromeEnvironmentClassName()} ${platformClassName()} ${appThemeClasses(settings, systemPrefersDark)} ${leftOpen ? "" : "left-collapsed"} ${effectiveRightOpen ? "right-open" : ""} ${isSettingsView ? "settings-active" : ""} ${newChatActive ? "new-chat-active" : ""} ${resizingPanel ? "panel-resizing" : ""}`}
      data-test-class="mac-window"
      style={panelStyle}
    >
      {isSettingsView ? (
        <SettingsView isActive={isSettingsView} />
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
            {view.kind === "automations" ||
            view.kind === "automation-detail" ? (
              <AutomationsView />
            ) : view.kind === "project-dashboard" ? (
              <ProjectDashboardView />
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
      {!isSettingsView && <WindowChromeLayer />}
      {!isSettingsView && effectiveRightOpen && <RightPanelOverlayTitlebar />}
      {commandOpen && <CommandPalette />}
      {renameProject && <ProjectRenameDialog />}
      {renameSession && <SessionRenameDialog />}
      <AppToaster />
    </div>
  );
}
