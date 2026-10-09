import { startupPaintReady } from "@/app/startupReady";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { useEffect } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import {
  AdaptivePanelResizeHandle,
  AdaptiveShell,
  AdaptiveShellChrome,
  AdaptiveShellInspector,
  AdaptiveShellScrim,
  AdaptiveShellSidebar,
  AdaptiveShellWorkspace,
  AdaptiveShellPeekEdge,
  useSidebarPeek,
  Stack,
  Spinner,
} from "@/butler-ds";
import { WindowChromeLayer } from "@/components/layout/Chrome.tsx";
import { RightPanelOverlayTitlebar } from "@/components/layout/RightPanelOverlayTitlebar.tsx";
import { Sidebar } from "@/components/layout/Sidebar.tsx";
import { useOrganizationNotice } from "@/components/space/hooks/useOrganizationNotice";
import { Titlebar } from "@/components/layout/Titlebar.tsx";
import { LiveConnectionNotice } from "@/components/layout/LiveConnectionNotice.tsx";
import { ConversationBrowserFrame } from "@/components/browser/ConversationBrowserFrame";
import { LibraryPage } from "@/components/browser/LibraryPage";
import { useBrowserShell } from "@/components/browser/useBrowserShell";
import { activeChatWallpaper } from "@/components/conversation/mainScreenTheme.ts";
import { BrowserArea } from "@/components/browser/BrowserArea";
import { Inspector } from "@/components/inspector/Inspector.tsx";
import { ProjectDashboardView } from "@/components/management/ProjectDashboardView.tsx";
import { AutomationsView } from "@/components/management/AutomationsView.tsx";
import { SettingsView } from "@/components/settings/SettingsView.tsx";
import { CommandPalette } from "@/components/command/CommandPalette.tsx";
import { useCommandPaletteHotkey } from "@/components/command/useCommandPaletteHotkey.ts";
import { ProjectRenameDialog } from "@/components/layout/ProjectRenameDialog.tsx";
import { ProjectCreateDialog } from "@/components/layout/ProjectCreateDialog.tsx";
import { SessionRenameDialog } from "@/components/layout/SessionRenameDialog.tsx";
import { SessionObserverDialog } from "@/components/layout/SessionObserverDialog.tsx";
import { AppToaster } from "@/components/common/AppToaster.tsx";
import { chromeEnvironment } from "@/app/chromeEnvironment.ts";
import { nativePlatform } from "@/app/nativeNotifications.ts";
import { appShellTheme, isDraftChatId } from "@/app/utils.ts";
import {
  selectEffectiveRightOpen,
  selectIsSettingsView,
  selectRightAvailable,
  useButlerStore,
} from "@/app/store.ts";
import { useAppBootstrap } from "@/hooks/useAppBootstrap.ts";
import { useAgentRuntimeState } from "@/hooks/useAgentRuntimeState.ts";
import { useNativeAppearanceTheme } from "@/hooks/useNativeAppearanceTheme.ts";
import { useNativeShellPreferences } from "@/hooks/useNativeShellPreferences.ts";
import { usePortalThemeClasses } from "@/hooks/usePortalThemeClasses.ts";
import { useSystemThemePreference } from "@/hooks/useSystemThemePreference.ts";
import { useWallpaperAppearance } from "@/hooks/useWallpaperAppearance.ts";
import { useAppearanceTheme } from "@/stores/appearanceStore.ts";
import {
  LEFT_PANEL_MAX_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  usePanelResize,
} from "@/hooks/usePanelResize.ts";
import { useNarrowRightPanelAutoCollapse } from "@/hooks/useNarrowRightPanelAutoCollapse.ts";
import { useBrowserChromeThemeColor } from "@/hooks/useBrowserChromeThemeColor.ts";
import { FirstRunSetup } from "@/components/first-run/FirstRunSetup.tsx";
import { notifyStatus } from "@/app/notifications.ts";
import { useOnboardingGate } from "@/hooks/useOnboardingGate.ts";
import { useOnboardingStore } from "@/stores/onboardingStore.ts";
import { LegacyDataRecovery } from "@/components/first-run/LegacyDataRecovery.tsx";

export function AppShell() {
  useEffect(() => { if (window.butlerApp?.startupIssue === "legacy-data") startupPaintReady(); }, []);
  if (window.butlerApp?.startupIssue === "legacy-data") return <ErrorBoundary scope="legacy-recovery"><LegacyDataRecovery /></ErrorBoundary>;
  return <AppOnboardingShell />;
}

function AppOnboardingShell() {
  useAppLocale();
  const { gate, markComplete } = useOnboardingGate();
  useEffect(() => { if (gate !== "pending" && gate !== "workspace") startupPaintReady(); }, [gate]);
  const rerunOpen = useOnboardingStore((state) => state.rerunOpen);
  const closeRerun = useOnboardingStore((state) => state.closeRerun);
  if (gate === "pending") return <AppBootState />;
  if (gate !== "workspace" || rerunOpen) {
    const mode = rerunOpen ? "rerun" : gate === "consent" ? "consent" : "first-run";
    return (
      <>
        <FirstRunTheme />
        <ErrorBoundary scope="onboarding">
          <FirstRunSetup
            key={mode}
            mode={mode}
            onCancel={closeRerun}
            onComplete={(result) => {
              if (result) useOnboardingStore.getState().setConnected(result.cardId);
              markComplete();
              closeRerun();
            }}
          />
        </ErrorBoundary>
        <AppToaster />
      </>
    );
  }
  return <AppWorkspaceShell />;
}

/** No setup or workspace mounts until the authoritative onboarding snapshot arrives. */
function AppBootState() {
  const settings = useButlerStore((state) => state.settings);
  const systemPrefersDark = useSystemThemePreference();
  return (
    <AdaptiveShell leftOpen={false} rightOpen={false}
      theme={appShellTheme(settings, systemPrefersDark)} chromeEnvironment={chromeEnvironment()}
      data-test-class="app-boot" aria-busy="true">
      <AdaptiveShellWorkspace><Stack fill justify="center" cross="center"><Spinner /></Stack></AdaptiveShellWorkspace>
    </AdaptiveShell>
  );
}

/** After a first run, open a new chat and say which AI is connected (once). */
function useFirstRunLanding() {
  const connectedCardId = useOnboardingStore((state) => state.connectedCardId);
  useEffect(() => {
    if (!connectedCardId) return;
    useOnboardingStore.getState().setConnected(null);
    useButlerStore.getState().openNewChat();
    notifyStatus(appCopy.firstRun.connectedToast(appCopy.firstRun.providerNames[connectedCardId]), {
      id: "first-run-connected",
      tone: "ok",
    });
  }, [connectedCardId]);
}

/** First-run renders outside the themed workspace, so theme the portal root. */
function FirstRunTheme() {
  const settings = useButlerStore((state) => state.settings);
  const systemPrefersDark = useSystemThemePreference();
  useNativeAppearanceTheme(settings.appearance_theme);
  usePortalThemeClasses(settings, systemPrefersDark);
  return null;
}

function AppWorkspaceShell() {
  useAppBootstrap();
  useFirstRunLanding();
  useAgentRuntimeState();
  useOrganizationNotice();
  const leftOpen = useButlerStore((state) => state.leftOpen);
  const setLeftOpen = useButlerStore((state) => state.setLeftOpen);
  const view = useButlerStore((state) => state.view);
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const settings = useButlerStore((state) => state.settings);
  const navigation = useButlerStore((state) => state.navigation);
  const rightOpen = useButlerStore((state) => state.rightOpen);
  const setRightOpen = useButlerStore((state) => state.setRightOpen);
  const systemPrefersDark = useSystemThemePreference();
  // A real-time wallpaper may set light/dark (its scene tone) over the setting.
  useWallpaperAppearance();
  const appearance = useAppearanceTheme();
  const themeSettings = appearance === settings.appearance_theme ? settings : { ...settings, appearance_theme: appearance };
  useNativeAppearanceTheme(appearance);
  useNativeShellPreferences(settings);
  usePortalThemeClasses(themeSettings, systemPrefersDark);
  const commandOpen = useButlerStore((state) => state.commandOpen);
  useCommandPaletteHotkey();
  const renameProject = useButlerStore((state) => state.renameProject);
  const renameSession = useButlerStore((state) => state.renameSession);
  const projectCreateDialogOpen = useButlerStore(
    (state) => state.projectCreateDialogOpen,
  );
  const requestedRightOpen = useButlerStore(selectEffectiveRightOpen);
  const rightAvailable = useButlerStore(selectRightAvailable);
  const isSettingsView = useButlerStore(selectIsSettingsView);
  const newChatActive =
    view.kind === "session" && isDraftChatId(activeChatId);
  const browserChromeDark =
    appearance === "dark" || (appearance === "system" && systemPrefersDark);
  useBrowserChromeThemeColor({
    active: newChatActive,
    dark: browserChromeDark,
    enabled: chromeEnvironment() === "browser",
  });
  const {
    shellRef,
    rightMin,
    rightMax,
    beginPanelResize,
    handlePanelResizeKeyDown,
    leftPanelWidth,
    panelStyle,
    rightPanelWidth,
    resizingPanel,
  } = usePanelResize({
    leftOpen,
    setLeftOpen: (value) => setLeftOpen(value),
  });
  const browser = useBrowserShell(shellRef, leftPanelWidth);
  const effectiveLeftOpen = leftOpen && !browser.autoCollapsed;
  const peek = useSidebarPeek(shellRef, {
    enabled: !effectiveLeftOpen && !isSettingsView,
    open: browser.peek,
    onOpenChange: browser.setPeek,
  });
  useEffect(() => window.butlerBrowser?.onPointer((point) => {
    if (point) peek.pointerAt(point);
    else peek.pointerOutside();
  }), [peek.pointerAt, peek.pointerOutside]);
  const effectiveRightOpen = requestedRightOpen && !browser.paneOpen;
  useNarrowRightPanelAutoCollapse({
    effectiveRightOpen,
    leftOpen: effectiveLeftOpen,
    rightOpen,
    setLeftOpen,
    setRightOpen,
  });

  return (
    <AdaptiveShell
      ref={shellRef}
      theme={appShellTheme(themeSettings, systemPrefersDark)}
      chromeEnvironment={chromeEnvironment()}
      data-test-class="mac-window"
      leftOpen={effectiveLeftOpen}
      leftPeek={peek.open}
      splitOpen={browser.paneOpen}
      compactSidebarFullWidth
      platform={nativePlatform()}
      resizing={Boolean(resizingPanel)}
      rightOpen={effectiveRightOpen}
      settingsActive={isSettingsView}
      UNSAFE_style={panelStyle}
      transparentWorkspace={
        newChatActive &&
        activeChatWallpaper(settings, navigation, activeChatId).source.kind !== "none"
      }
    >
      {isSettingsView ? (
        <ErrorBoundary scope="settings"><SettingsView isActive={isSettingsView} /></ErrorBoundary>
      ) : (
        <>
          <AdaptiveShellSidebar
            data-test-class="sidebar-slot"
            id="butler-left-sidebar"
            open={effectiveLeftOpen}
          >
            <Sidebar />
          </AdaptiveShellSidebar>
          <AdaptiveShellWorkspace
            data-test-class="workspace"
          >
            <Titlebar sidebarOpen={effectiveLeftOpen} />
            <Stack fill gap="none">
              <LiveConnectionNotice />
              <Stack fill gap="none">
                {view.kind === "browser" && window.butlerBrowser ? <BrowserArea /> : view.kind === "library" ? <LibraryPage /> : view.kind === "automations" ||
                view.kind === "automation-detail" ? (
                  <ErrorBoundary key={view.kind} scope="schedules"><AutomationsView /></ErrorBoundary>
                ) : view.kind === "project-dashboard" ? (
                  <ErrorBoundary key={view.projectId} scope="project-dashboard"><ProjectDashboardView /></ErrorBoundary>
                ) : (
                  <ErrorBoundary key={activeChatId} scope="conversation"><ConversationBrowserFrame
                    sessionId={activeChatId} paneOpen={browser.paneOpen} chatWidth={browser.chatWidth} /></ErrorBoundary>
                )}
              </Stack>
            </Stack>
          </AdaptiveShellWorkspace>
        </>
      )}
      {!isSettingsView && !effectiveLeftOpen && <AdaptiveShellPeekEdge onPeek={peek.show} />}
      {!isSettingsView && effectiveLeftOpen && (
        <AdaptivePanelResizeHandle
          aria-label={appCopy.titlebar.resizeLeftPanel}
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
          data-test-class="right-panel-slot"
          open={effectiveRightOpen}
        >
          <ErrorBoundary scope="inspector">
            <Inspector id="butler-right-inspector" />
          </ErrorBoundary>
        </AdaptiveShellInspector>
      )}
      {!isSettingsView && effectiveRightOpen && (
        <AdaptivePanelResizeHandle
          aria-label={appCopy.titlebar.resizeRightPanel}
          aria-orientation="vertical"
          aria-controls="butler-right-inspector"
          aria-valuemax={rightMax}
          aria-valuemin={rightMin}
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
            effectiveRightOpen ? appCopy.titlebar.hideRightPanel : appCopy.titlebar.hideLeftPanel
          }
          open={effectiveLeftOpen || effectiveRightOpen}
          onDismiss={() =>
            effectiveRightOpen ? setRightOpen(false) : setLeftOpen(false)
          }
        />
      )}
      {!isSettingsView && (
        <AdaptiveShellChrome>
          <WindowChromeLayer leftOpen={effectiveLeftOpen} onToggle={() => {
            if (browser.autoCollapsed) browser.setPeek(!browser.peek);
            else setLeftOpen((value) => !value);
          }} />
        </AdaptiveShellChrome>
      )}
      {!isSettingsView && effectiveRightOpen && <RightPanelOverlayTitlebar />}
      <CommandPalette open={commandOpen} />
      {projectCreateDialogOpen && <ProjectCreateDialog />}
      {renameProject && <ProjectRenameDialog />}
      {renameSession && <SessionRenameDialog />}
      <SessionObserverDialog />
      <AppToaster />
    </AdaptiveShell>
  );
}
