import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import {
  AdaptivePanelResizeHandle,
  AdaptiveShell,
  AdaptiveShellChrome,
  AdaptiveShellInspector,
  AdaptiveShellScrim,
  AdaptiveShellSidebar,
  AdaptiveShellWorkspace,
} from "@/butler-ds";
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
import { chromeEnvironment } from "@/app/chromeEnvironment.ts";
import { nativePlatform } from "@/app/nativeNotifications.ts";
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
  const rightOpen = useButlerStore((state) => state.rightOpen);
  const setRightOpen = useButlerStore((state) => state.setRightOpen);
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
    effectiveRightOpen,
    leftOpen,
    rightOpen,
    setLeftOpen,
    setRightOpen,
  });

  return (
    <AdaptiveShell
      className={`mac-window ${appThemeClasses(settings, systemPrefersDark)}`}
      chromeEnvironment={chromeEnvironment()}
      data-test-class="mac-window"
      leftOpen={leftOpen}
      platform={nativePlatform()}
      resizing={Boolean(resizingPanel)}
      rightOpen={effectiveRightOpen}
      settingsActive={isSettingsView}
      style={panelStyle}
      transparentWorkspace={
        newChatActive &&
        (settings.main_screen_theme === "bloom" ||
          settings.main_screen_theme === "silk")
      }
    >
      {isSettingsView ? (
        <SettingsView isActive={isSettingsView} />
      ) : (
        <>
          <AdaptiveShellSidebar
            className="sidebar-slot"
            data-test-class="sidebar-slot"
            id="butler-left-sidebar"
            open={leftOpen}
          >
            <Sidebar />
          </AdaptiveShellSidebar>
          <AdaptiveShellWorkspace
            className="workspace"
            data-test-class="workspace"
          >
            <Titlebar />
            {view.kind === "automations" ||
            view.kind === "automation-detail" ? (
              <AutomationsView />
            ) : view.kind === "project-dashboard" ? (
              <ProjectDashboardView />
            ) : (
              <Conversation />
            )}
          </AdaptiveShellWorkspace>
        </>
      )}
      {!isSettingsView && leftOpen && (
        <AdaptivePanelResizeHandle
          aria-label="Resize left sidebar"
          aria-orientation="vertical"
          aria-controls="butler-left-sidebar"
          aria-valuemax={LEFT_PANEL_MAX_WIDTH}
          aria-valuemin={LEFT_PANEL_MIN_WIDTH}
          aria-valuenow={leftPanelWidth}
          data-test-class="panel-resize-handle left-panel-resize-handle"
          side="left"
          onKeyDown={(event) => handlePanelResizeKeyDown("left", event)}
          onPointerDown={(event) => beginPanelResize("left", event)}
        />
      )}
      {!isSettingsView && rightAvailable && (
        <AdaptiveShellInspector
          className="right-panel-slot"
          data-test-class="right-panel-slot"
          open={effectiveRightOpen}
        >
          <Inspector id="butler-right-inspector" />
        </AdaptiveShellInspector>
      )}
      {!isSettingsView && effectiveRightOpen && (
        <AdaptivePanelResizeHandle
          aria-label="Resize right panel"
          aria-orientation="vertical"
          aria-controls="butler-right-inspector"
          aria-valuemax={RIGHT_PANEL_MAX_WIDTH}
          aria-valuemin={RIGHT_PANEL_MIN_WIDTH}
          aria-valuenow={rightPanelWidth}
          data-test-class="panel-resize-handle right-panel-resize-handle"
          side="right"
          onKeyDown={(event) => handlePanelResizeKeyDown("right", event)}
          onPointerDown={(event) => beginPanelResize("right", event)}
        />
      )}
      {!isSettingsView && (
        <AdaptiveShellScrim
          label={
            effectiveRightOpen ? appCopy.titlebar.hideRightPanel : "Hide sidebar"
          }
          open={leftOpen || effectiveRightOpen}
          onDismiss={() =>
            effectiveRightOpen ? setRightOpen(false) : setLeftOpen(false)
          }
        />
      )}
      {!isSettingsView && (
        <AdaptiveShellChrome>
          <WindowChromeLayer />
        </AdaptiveShellChrome>
      )}
      {!isSettingsView && effectiveRightOpen && <RightPanelOverlayTitlebar />}
      {commandOpen && <CommandPalette />}
      {renameProject && <ProjectRenameDialog />}
      {renameSession && <SessionRenameDialog />}
      <AppToaster />
    </AdaptiveShell>
  );
}
