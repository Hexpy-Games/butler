import { initialDocumentView } from "@/app/documentRoute";
import { useDrawerSidebarState } from "@/hooks/useDrawerSidebarState.ts";
import { useSessionAttentionNotifications } from "@/hooks/live-session/useSessionAttentionNotifications";
import { useEffect, useMemo } from "react";
import { stewardHarnessSummary } from "./stewardHarnessSummary.ts";
import { appCopy } from "@/app/copy.ts";
import {
  AdaptivePanelResizeHandle,
  AdaptiveShell,
  AdaptiveShellChrome,
  AdaptiveShellScrim,
  AdaptiveShellSidebar,
  AdaptiveShellWorkspace,
  Stack,
} from "@/butler-ds";
import { WindowChromeLayer } from "@/components/layout/Chrome.tsx";
import { Sidebar } from "@/components/layout/Sidebar.tsx";
import { Titlebar } from "@/components/layout/Titlebar.tsx";
import { LibraryPage } from "@/components/browser/LibraryPage";
import { Conversation } from "@/components/conversation/Conversation.tsx";
import { PlanOverview } from "@/components/canon/PlanOverview.tsx";
import { ProjectDashboardView } from "@/components/management/ProjectDashboardView.tsx";
import { AppToaster } from "@/components/common/AppToaster.tsx";
import { ImageViewerHost } from "@/components/media/ImageViewerHost";
import { SettingsView } from "@/components/settings/SettingsView.tsx";
import { SessionObserverDialog } from "@/components/layout/SessionObserverDialog.tsx";
import { ProjectCreateDialog } from "@/components/layout/ProjectCreateDialog.tsx";
import { CommandPalette } from "@/components/command/CommandPalette.tsx";
import { BrowserArea } from "@/components/browser/BrowserArea";
import { ConversationBrowserFrame } from "@/components/browser/ConversationBrowserFrame";
import { useBrowserShellState } from "@/components/browser/browserShellState";
import { useRightSlot } from "@/components/file-viewer/useRightSlot";
import { connectBrowser } from "@/components/browser/browserBridge";
import { useComposerStore } from "@/components/conversation/composerStore.ts";
import { chromeEnvironment } from "@/app/chromeEnvironment.ts";
import { EMPTY_SETTINGS } from "@/app/constants.ts";
import { nativePlatform } from "@/app/nativeNotifications.ts";
import {
  HARNESS_MODEL_CATALOG,
  HARNESS_MESSAGES,
  HARNESS_NAVIGATION,
  HARNESS_PRIMARY_MODEL,
  HARNESS_PROJECT_DASHBOARD,
  HARNESS_SS03_NAVIGATION,
  HARNESS_SS03_OBSERVER_VIEW,
  HARNESS_SUMMARY,
} from "@/app/fixtures.ts";
import { appShellTheme, isDraftChatId, projectDraftId } from "@/app/utils.ts";
import type { ModelCatalogView, WorkerProfile } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import {
  LEFT_PANEL_MAX_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  usePanelResize,
} from "@/hooks/usePanelResize.ts";
import { usePortalThemeClasses } from "@/hooks/usePortalThemeClasses.ts";
import { useSystemThemePreference } from "@/hooks/useSystemThemePreference.ts";

/** `?auth=subscription|api_key|local` bills the harness model that way (context usage popover). */
function harnessModelCatalog(auth: string | null): ModelCatalogView {
  const billing = auth === "subscription" ? { auth_type: "chatgpt_oauth" as const }
    : auth === "api_key" ? { auth_type: "api_key" as const }
      : auth === "local" ? { platform: "llama_cpp" as const }
        : null;
  if (!billing) return HARNESS_MODEL_CATALOG;
  const bill = <Model extends { model_ref: string }>(model: Model): Model =>
    model.model_ref === HARNESS_PRIMARY_MODEL.model_ref ? { ...model, ...billing } : model;
  return {
    ...HARNESS_MODEL_CATALOG,
    models: HARNESS_MODEL_CATALOG.models.map(bill),
    providers: HARNESS_MODEL_CATALOG.providers.map((provider) => ({ ...provider, models: provider.models.map(bill) })),
  };
}

export function VisualHarness() {
  const fixture = (window as Window & { butlerConversationFixture?: { messages: import("@/app/types").MessageRecord[]; background?: string; sessionView?: import("@/app/types").SessionView; navigation?: import("@/app/types").NavigationView; modelCatalog?: ModelCatalogView; settings?: Partial<import("@/app/types").SettingsView> } }).butlerConversationFixture;
  const leftOpen = useButlerStore((state) => state.leftOpen);
  const setLeftOpen = useButlerStore((state) => state.setLeftOpen);
  const view = useButlerStore((state) => state.view);
  const commandOpen = useButlerStore((state) => state.commandOpen);
  const setView = useButlerStore((state) => state.setView);
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const setActiveChatId = useButlerStore((state) => state.setActiveChatId);
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
  const harnessCatalog = useMemo(
    () => fixture?.modelCatalog ?? harnessModelCatalog(new URLSearchParams(window.location.search).get("auth")),
    [],
  );
  const worktreeSurface =
    new URLSearchParams(window.location.search).get("surface") === "worktree";
  // `developer=1` turns on developer mode (context and worker tabs, Git details).
  const developerMode =
    new URLSearchParams(window.location.search).get("developer") === "1";
  const harnessNavigation = fixture?.navigation ?? (ss03Surface
    ? HARNESS_SS03_NAVIGATION
    : HARNESS_NAVIGATION);
  const harnessSummary = useMemo(
    () => ss03Surface
      // `steward=finalizing|delivered` swaps in that #307 Steward child state.
      ? stewardHarnessSummary(new URLSearchParams(window.location.search).get("steward") ?? "")
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
  const harnessSettings = useMemo(() => {
    const workerProfiles: WorkerProfile[] = [
      {
        id: "default",
        label: appCopy.interfaceDetails.default,
        enabled: true,
        job: { kind: "builtin", job: "coding" },
        model: HARNESS_PRIMARY_MODEL.model_ref,
        reasoning_effort: HARNESS_PRIMARY_MODEL.default_reasoning_effort,
      },
    ];
    // `?locale=ko` renders the harness in Korean.
    const language = new URLSearchParams(window.location.search).get("locale") === "ko" ? "ko" : EMPTY_SETTINGS.language;
    const background = fixture?.background === "plain" ? { conversation_background: { source: { kind: "none" as const }, overlay: 0 } } : {};
    return visualTheme === EMPTY_SETTINGS.appearance_theme
      ? { ...EMPTY_SETTINGS, ...background, language, diagnostics_enabled: developerMode, worker_profiles: workerProfiles, ...fixture?.settings }
      : {
          ...EMPTY_SETTINGS,
          ...background,
          appearance_theme: visualTheme,
          language,
          diagnostics_enabled: developerMode,
          worker_profiles: workerProfiles,
          ...fixture?.settings,
        };
  }, [developerMode, visualTheme]);
  const systemPrefersDark = useSystemThemePreference();
  usePortalThemeClasses(harnessSettings, systemPrefersDark);
  const isSettingsView = view.kind === "settings";
  const newChatActive =
    view.kind === "session" && isDraftChatId(activeChatId);
  const {
    shellRef,
    beginPanelResize,
    handlePanelResizeKeyDown,
    leftPanelWidth,
    panelStyle,
    resizingPanel,
  } = usePanelResize({
    leftOpen,
    setLeftOpen,
  });
  useDrawerSidebarState({ leftOpen, setLeftOpen });
  useEffect(() => {
    if (ss03Surface) {
      setLeftOpen(true);
    } else {
      setLeftOpen(false);
    }
    setView(initialDocumentView());
    setActiveChatId(fixture?.sessionView?.session_id ?? "butler-client");
    setNavigation(harnessNavigation);
    setMessages(fixture?.messages ?? HARNESS_MESSAGES);
    setSettings(harnessSettings);
    setModelCatalog(harnessCatalog);
    setSummary(fixture?.sessionView ? null : harnessSummary);
    if (fixture?.sessionView) setSessionView(fixture.sessionView);
    if (ss03Surface) {
      setSessionView(HARNESS_SS03_OBSERVER_VIEW);
      openSessionObserver(HARNESS_SS03_OBSERVER_VIEW.session_id);
    }
    setTurnProgress(
      !fixture?.sessionView && harnessSummary.latest_progress?.turn_id
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
    harnessCatalog,
    setActiveChatId,
    setLeftOpen,
    setModelCatalog,
    setMessages,
    setNavigation,
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
  // The harness stands in for the session load: reopening its session brings its summary back.
  const summaryMissing = useButlerStore((state) => state.summary === null);
  useEffect(() => {
    if (!fixture?.sessionView && summaryMissing && activeChatId === harnessSummary.session_id) setSummary(harnessSummary);
  }, [activeChatId, fixture?.sessionView, harnessSummary, setSummary, summaryMissing]);
  useSessionAttentionNotifications();
  // The desktop bridge, when present, feeds the browser and the agent tab rail (as the app bootstrap does).
  useEffect(() => {
    if (window.butlerBrowser) connectBrowser();
  }, []);
  useEffect(() => {
    if (!ss03Surface) return;
    const timer = window.setTimeout(() => {
      useComposerStore.getState().setEngaged(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ss03Surface]);
  return (
    <AdaptiveShell
      ref={shellRef}
      theme={appShellTheme(harnessSettings, systemPrefersDark)}
      chromeEnvironment={chromeEnvironment()}
      data-test-class="mac-window visual-harness"
      leftOpen={leftOpen}
      platform={nativePlatform()}
      resizing={Boolean(resizingPanel)}
      rightOpen={false}
      settingsActive={isSettingsView}
      UNSAFE_style={panelStyle}
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
      {isSettingsView ? (
        <SettingsView
          initialSection="general"
          onClose={() => setView({ kind: "session" })}
          isActive={isSettingsView}
        />
      ) : (
        <>
          <AdaptiveShellSidebar
            data-test-class="sidebar-slot"
            id="butler-left-sidebar"
            open={leftOpen}
          >
            <Sidebar />
          </AdaptiveShellSidebar>
          <AdaptiveShellWorkspace
            data-test-class="workspace"
          >
            <Titlebar />
            {view.kind === "library" ? <LibraryPage /> : view.kind === "browser" ? (
              <Stack fill gap="none"><BrowserArea /></Stack>
            ) : view.kind === "plan-overview" ? (
              <PlanOverview key={`${view.projectId}:${view.planId}`} projectId={view.projectId} planId={view.planId} />
            ) : view.kind === "project-dashboard" ? (
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
              <HarnessConversation />
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
      {!isSettingsView && (
        <AdaptiveShellScrim
          label="Hide sidebar"
          open={!ss03Surface && leftOpen}
          onDismiss={() => setLeftOpen(false)}
        />
      )}
      {(isSettingsView || fixture) && <AppToaster />}
      {fixture && <ImageViewerHost />}
      {ss03Surface && <SessionObserverDialog />}
      <CommandPalette open={commandOpen} />
      <ProjectCreateDialog />
    </AdaptiveShell>
  );
}

/** As in the App: the conversation alone, or beside the right slot's pane (browser or file viewer). */
function HarnessConversation() {
  const session = useButlerStore((state) => state.activeChatId);
  const pane = useRightSlot(session);
  const chatWidth = useBrowserShellState((state) => state.chatWidth);
  return pane ? <ConversationBrowserFrame sessionId={session} pane={pane} chatWidth={chatWidth} /> : <Conversation />;
}
