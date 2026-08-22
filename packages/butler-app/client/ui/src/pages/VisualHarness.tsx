import { useEffect, useMemo } from "react";
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
import { SettingsView } from "@/components/settings/SettingsView.tsx";
import { SessionObserverDialog } from "@/components/layout/SessionObserverDialog.tsx";
import { useComposerStore } from "@/components/conversation/composerStore.ts";
import { chromeEnvironment } from "@/app/chromeEnvironment.ts";
import { EMPTY_SETTINGS } from "@/app/constants.ts";
import { nativePlatform } from "@/app/nativeNotifications.ts";
import {
  HARNESS_MODEL_CATALOG,
  HARNESS_MESSAGES,
  HARNESS_NAVIGATION,
  HARNESS_PROJECT_DASHBOARD,
  HARNESS_SS03_NAVIGATION,
  HARNESS_SS03_OBSERVER_VIEW,
  HARNESS_SS03_SUMMARY,
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
  const setSessionView = useButlerStore((state) => state.setSessionView);
  const openSessionObserver = useButlerStore(
    (state) => state.openSessionObserver,
  );
  const setTurnProgress = useButlerStore((state) => state.setTurnProgress);
  const setStatus = useButlerStore((state) => state.setStatus);
  const visualTheme =
    new URLSearchParams(window.location.search).get("theme") === "dark"
      ? "dark"
      : EMPTY_SETTINGS.appearance_theme;
  const ss03Surface =
    new URLSearchParams(window.location.search).get("surface") === "ss03";
  const worktreeSurface =
    new URLSearchParams(window.location.search).get("surface") === "worktree";
  const harnessNavigation = ss03Surface
    ? HARNESS_SS03_NAVIGATION
    : HARNESS_NAVIGATION;
  const harnessSummary = useMemo(
    () => ss03Surface
      ? HARNESS_SS03_SUMMARY
      : worktreeSurface
        ? {
            ...HARNESS_SUMMARY,
            branch_info: {
              available: true,
              workspace_mode: "git" as const,
              branch_name: "codex/session-worktree-visibility-with-a-long-branch",
              safe_status: "Git branch codex/session-worktree-visibility-with-a-long-branch",
              workspace_binding: "session_worktree" as const,
              workspace_label: "session-worktree/codex/session-worktree-visibility-with-a-long-branch",
              workspace_status: "available" as const,
              dirty: true,
            },
          }
        : HARNESS_SUMMARY,
    [ss03Surface, worktreeSurface],
  );
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
    effectiveRightOpen,
    leftOpen,
    rightOpen,
    setLeftOpen,
    setRightOpen,
  });
  useEffect(() => {
    if (ss03Surface) {
      setLeftOpen(true);
    } else {
      setLeftOpen(false);
    }
    setRightOpen(true);
    setRightTab("summary");
    setView({ kind: "session" });
    setActiveChatId("butler-client");
    setNavigation(harnessNavigation);
    setMessages(HARNESS_MESSAGES);
    setSettings(harnessSettings);
    setModelCatalog(HARNESS_MODEL_CATALOG);
    setSummary(harnessSummary);
    if (ss03Surface) {
      setSessionView(HARNESS_SS03_OBSERVER_VIEW);
      openSessionObserver(HARNESS_SS03_OBSERVER_VIEW.session_id);
    }
    setTurnProgress(
      harnessSummary.latest_progress?.turn_id
        ? {
            [harnessSummary.latest_progress.turn_id]: {
              ...harnessSummary.latest_progress,
              state: harnessSummary.turn_state,
            },
          }
        : {},
    );
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
    setSessionView,
    setView,
    setSummary,
    setTurnProgress,
    openSessionObserver,
    harnessSummary,
    harnessNavigation,
    ss03Surface,
  ]);
  useEffect(() => {
    if (!ss03Surface) return;
    const timer = window.setTimeout(() => {
      useComposerStore.getState().setEngaged(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ss03Surface]);
  return (
    <AdaptiveShell
      className={`mac-window visual-harness ${appThemeClasses(harnessSettings, systemPrefersDark)}`}
      chromeEnvironment={chromeEnvironment()}
      data-test-class="mac-window visual-harness"
      leftOpen={leftOpen}
      platform={nativePlatform()}
      resizing={Boolean(resizingPanel)}
      rightOpen={effectiveRightOpen}
      settingsActive={isSettingsView}
      style={panelStyle}
      transparentWorkspace={newChatActive}
    >
      {!isSettingsView && (
        <AdaptiveShellChrome>
          <WindowChromeLayer
            leftOpen={leftOpen}
            onToggle={() => setLeftOpen((value) => !value)}
          />
        </AdaptiveShellChrome>
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
            {view.kind === "project-dashboard" ? (
              <ProjectDashboardView
                initialDashboard={HARNESS_PROJECT_DASHBOARD}
                project={harnessNavigation.projects.find(
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
          open={!ss03Surface && (leftOpen || effectiveRightOpen)}
          onDismiss={() =>
            effectiveRightOpen ? setRightOpen(false) : setLeftOpen(false)
          }
        />
      )}
      {ss03Surface && <SessionObserverDialog />}
    </AdaptiveShell>
  );
}
