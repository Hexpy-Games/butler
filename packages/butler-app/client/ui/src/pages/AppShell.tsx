import { useDrawerSidebarState } from "@/hooks/useDrawerSidebarState.ts";
import { useImageEditorState } from "@/components/images/imageEditorState";
import { startupPaintReady } from "@/app/startupReady";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { useEffect } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import {
  AdaptivePanelResizeHandle,
  AdaptiveShell,
  AdaptiveShellChrome,
  AdaptiveShellCard,
  AdaptiveShellTitle,
  AdaptiveShellScrim,
  AdaptiveShellSidebar,
  AdaptiveShellWorkspace,
  AdaptiveShellPeekEdge,
  useSidebarPeek,
  useAdaptiveDrawer,
  Stack,
  Spinner,
} from "@/butler-ds";
import { WindowChromeLayer } from "@/components/layout/Chrome.tsx";
import { Sidebar } from "@/components/layout/Sidebar.tsx";
import { useOrganizationNotice } from "@/components/space/hooks/useOrganizationNotice";
import { Titlebar } from "@/components/layout/Titlebar.tsx";
import { LiveConnectionNotice } from "@/components/layout/LiveConnectionNotice.tsx";
import { ConversationBrowserFrame } from "@/components/browser/ConversationBrowserFrame";
import type { RightSlotPane } from "@/components/file-viewer/useRightSlot";
import { LibraryDialogHost } from "@/components/library/LibraryDialogHost";
import { CardDragPreview } from "@/components/library/CardDragPreview";
import { HistoryPage } from "@/components/browser/HistoryPage";
import { LibraryPage } from "@/components/browser/LibraryPage";
import { useBrowserShell } from "@/components/browser/useBrowserShell";
import { activeChatWallpaper } from "@/components/conversation/mainScreenTheme.ts";
import { ElementDragPreview } from "@/components/browser/ElementDragPreview";
import { TabDragPreview } from "@/components/browser/TabDragPreview";
import { BrowserArea } from "@/components/browser/BrowserArea";
import { PlanOverview } from "@/components/canon/PlanOverview.tsx";
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
import { ImageViewerHost } from "@/components/media/ImageViewerHost";
import { chromeEnvironment } from "@/app/chromeEnvironment.ts";
import { nativePlatform } from "@/app/nativeNotifications.ts";
import { appShellTheme, isDraftChatId } from "@/app/utils.ts";
import {
  selectIsSettingsView,
  useButlerStore,
} from "@/app/store.ts";
import { useAppBootstrap } from "@/hooks/useAppBootstrap.ts";
import { useAgentRuntimeState } from "@/hooks/useAgentRuntimeState.ts";
import { useTextSize } from "@/hooks/useTextSize";
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
import { useBrowserChromeThemeColor } from "@/hooks/useBrowserChromeThemeColor.ts";
import { FirstRunSetup } from "@/components/first-run/FirstRunSetup.tsx";
import { useOnboardingGate } from "@/hooks/useOnboardingGate.ts";
import { useOnboardingStore } from "@/stores/onboardingStore.ts";
import { LegacyDataRecovery } from "@/components/first-run/LegacyDataRecovery.tsx";

export function AppShell() {
  const textSize = useButlerStore((state) => state.settings.text_size);
  useTextSize(textSize);
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

/** After a first run, open a new chat. The connect step already showed the connection. */
function useFirstRunLanding() {
  const connectedCardId = useOnboardingStore((state) => state.connectedCardId);
  useEffect(() => {
    if (!connectedCardId) return;
    useOnboardingStore.getState().setConnected(null);
    useButlerStore.getState().openNewChat();
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

function useWorkspaceTheme() {
  const settings = useButlerStore((state) => state.settings);
  const navigation = useButlerStore((state) => state.navigation);
  const view = useButlerStore((state) => state.view);
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const systemPrefersDark = useSystemThemePreference();
  // A real-time wallpaper may set light/dark (its scene tone) over the setting.
  useWallpaperAppearance();
  const appearance = useAppearanceTheme();
  const themeSettings = appearance === settings.appearance_theme ? settings : { ...settings, appearance_theme: appearance };
  useNativeAppearanceTheme(appearance);
  useNativeShellPreferences(settings);
  usePortalThemeClasses(themeSettings, systemPrefersDark);
  const newChatActive = view.kind === "session" && isDraftChatId(activeChatId);
  useBrowserChromeThemeColor({ active: newChatActive,
    dark: appearance === "dark" || (appearance === "system" && systemPrefersDark),
    enabled: chromeEnvironment() === "browser" });
  return { theme: appShellTheme(themeSettings, systemPrefersDark),
    transparentWorkspace: newChatActive && activeChatWallpaper(settings, navigation, activeChatId).source.kind !== "none" };
}

function useWorkspacePanels() {
  const leftOpen = useButlerStore((state) => state.leftOpen);
  const setLeftOpen = useButlerStore((state) => state.setLeftOpen);
  const isSettingsView = useButlerStore(selectIsSettingsView);
  const resize = usePanelResize({ leftOpen, setLeftOpen: (value) => setLeftOpen(value) });
  const browser = useBrowserShell(resize.shellRef, resize.leftPanelWidth);
  const drawer = useAdaptiveDrawer(chromeEnvironment());
  const effectiveLeftOpen = leftOpen && (drawer || !browser.autoCollapsed);
  useDrawerSidebarState({ leftOpen: effectiveLeftOpen, setLeftOpen });
  const peek = useSidebarPeek(resize.shellRef, {
    enabled: !drawer && !effectiveLeftOpen && !isSettingsView,
    open: browser.peek, onOpenChange: browser.setPeek,
  });
  useEffect(() => window.butlerBrowser?.onPointer((point) => {
    if (point) peek.pointerAt(point);
    else peek.pointerOutside();
  }), [peek.pointerAt, peek.pointerOutside]);
  return { resize, browser, peek, drawer, effectiveLeftOpen,
    isSettingsView, setLeftOpen };
}

type WorkspacePanels = ReturnType<typeof useWorkspacePanels>;

function AppWorkspaceShell() {
  useAppBootstrap();
  useFirstRunLanding();
  useAgentRuntimeState();
  useOrganizationNotice();
  useCommandPaletteHotkey();
  const theme = useWorkspaceTheme();
  const panels = useWorkspacePanels();
  const editingImage = useImageEditorState(s => Boolean(s.target));
  const { resize, browser, peek, effectiveLeftOpen, isSettingsView } = panels;
  return (
    <AdaptiveShell frame="cards" ref={resize.shellRef} {...theme}
      chromeEnvironment={chromeEnvironment()} data-test-class="mac-window"
      leftOpen={effectiveLeftOpen} leftPeek={peek.open} splitOpen={browser.paneOpen || editingImage}
      compactSidebarFullWidth platform={nativePlatform()} resizing={Boolean(resize.resizingPanel)}
      rightOpen={false} settingsActive={isSettingsView} UNSAFE_style={resize.panelStyle}>
      <AppWorkspaceContent leftOpen={effectiveLeftOpen} pane={browser.pane} chatWidth={browser.chatWidth} />
      <AppWorkspaceControls panels={panels} />
      <AppWorkspaceDialogs />
    </AdaptiveShell>
  );
}

function AppWorkspaceContent({ leftOpen, pane, chatWidth }: { leftOpen: boolean; pane: RightSlotPane; chatWidth: number }) {
  const view = useButlerStore((state) => state.view);
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const isSettingsView = useButlerStore(selectIsSettingsView);
  if (isSettingsView) return <ErrorBoundary scope="settings"><SettingsView isActive={isSettingsView} /></ErrorBoundary>;
  return <>
    <AdaptiveShellSidebar data-test-class="sidebar-slot" id="butler-left-sidebar" open={leftOpen}>
      <Sidebar />
    </AdaptiveShellSidebar>
    <AdaptiveShellWorkspace data-test-class="workspace">
      <AdaptiveShellTitle><Titlebar sidebarOpen={leftOpen} splitChatWidth={pane ? chatWidth : undefined} /></AdaptiveShellTitle>
      {view.kind === "browser" && window.butlerBrowser ? (
        <Stack fill gap="none"><LiveConnectionNotice /><BrowserArea /></Stack>
      ) : view.kind === "history" ? (
        <AdaptiveShellCard><LiveConnectionNotice /><HistoryPage /></AdaptiveShellCard>
      ) : view.kind === "library" ? (
        <AdaptiveShellCard><LiveConnectionNotice /><LibraryPage /></AdaptiveShellCard>
      ) : view.kind === "automations" || view.kind === "automation-detail" ? (
        <AdaptiveShellCard><LiveConnectionNotice /><ErrorBoundary key={view.kind} scope="schedules"><AutomationsView /></ErrorBoundary></AdaptiveShellCard>
      ) : view.kind === "plan-overview" ? (
        <AdaptiveShellCard><LiveConnectionNotice /><ErrorBoundary key={`${view.projectId}:${view.planId}`} scope="plan-overview"><PlanOverview projectId={view.projectId} planId={view.planId} /></ErrorBoundary></AdaptiveShellCard>
      ) : view.kind === "project-dashboard" ? (
        <AdaptiveShellCard><LiveConnectionNotice /><ErrorBoundary key={view.projectId} scope="project-dashboard"><ProjectDashboardView /></ErrorBoundary></AdaptiveShellCard>
      ) : (
        <ErrorBoundary resetKey={activeChatId} scope="conversation"><ConversationBrowserFrame
          sessionId={activeChatId} pane={pane} chatWidth={chatWidth} notice={<LiveConnectionNotice />} /></ErrorBoundary>
      )}
    </AdaptiveShellWorkspace>
  </>;
}

function AppWorkspaceControls({ panels }: { panels: WorkspacePanels }) {
  const { resize, browser, peek, drawer, effectiveLeftOpen,
    isSettingsView, setLeftOpen } = panels;
  if (isSettingsView) return null;
  return <>
    {!drawer && !effectiveLeftOpen && <AdaptiveShellPeekEdge onPeek={peek.show} />}
    {effectiveLeftOpen && <AdaptivePanelResizeHandle
      aria-label={appCopy.titlebar.resizeLeftPanel} hint={appCopy.titlebar.dragToResize}
      aria-orientation="vertical" aria-controls="butler-left-sidebar"
      aria-valuemax={LEFT_PANEL_MAX_WIDTH} aria-valuemin={LEFT_PANEL_MIN_WIDTH} aria-valuenow={resize.leftPanelWidth}
      data-test-class="panel-resize-handle left-panel-resize-handle" side="left"
      onKeyDown={(event) => resize.handlePanelResizeKeyDown("left", event)}
      onPointerDown={(event) => resize.beginPanelResize("left", event)} />}
    <AdaptiveShellScrim label={appCopy.titlebar.hideLeftPanel}
      open={effectiveLeftOpen}
      onDismiss={() => setLeftOpen(false)} />
    <AdaptiveShellChrome>
      <WindowChromeLayer leftOpen={effectiveLeftOpen} onToggle={() => {
        if (browser.autoCollapsed && !drawer) browser.setPeek(!browser.peek);
        else setLeftOpen((value) => !value);
      }} />
    </AdaptiveShellChrome>
  </>;
}

function AppWorkspaceDialogs() {
  const commandOpen = useButlerStore((state) => state.commandOpen);
  const projectCreateDialogOpen = useButlerStore((state) => state.projectCreateDialogOpen);
  const renameProject = useButlerStore((state) => state.renameProject);
  const renameSession = useButlerStore((state) => state.renameSession);
  return <>
    <CommandPalette open={commandOpen} />
    {projectCreateDialogOpen && <ProjectCreateDialog />}
    {renameProject && <ProjectRenameDialog />}
    {renameSession && <SessionRenameDialog />}
    <SessionObserverDialog />
    <ElementDragPreview />
    <TabDragPreview />
    <CardDragPreview />
    <LibraryDialogHost />
    <ImageViewerHost />
    <AppToaster />
  </>;
}
