import { useEffect, useRef } from "react";
import { api } from "@/app/api.ts";
import { EMPTY_NAVIGATION } from "@/app/constants.ts";
import {
  messageListSyncCursor,
  readCachedMessageList,
  writeCachedMessageList,
} from "@/app/messageCache.ts";
import {
  readCachedAppUiState,
  writeCachedAppUiState,
} from "@/app/appUiStateCache.ts";
import { readCachedSettings } from "@/app/settingsCache.ts";
import { notifyError } from "@/app/notifications.ts";
import { isDraftChatId } from "@/app/utils.ts";
import { isServerBackedSessionId } from "@/app/sessionIds.ts";
import {
  selectActiveSessionView,
  selectRightAvailable,
  useButlerStore,
} from "@/app/store.ts";
import type {
  MessageListView,
  ModelCatalogView,
  NavigationView,
  SessionView,
  SettingsView,
} from "@/app/types.ts";
import { recoverBootstrapResource } from "./bootstrapResource.ts";
import { useLiveSessionEvents } from "./live-session/useLiveSessionEvents.ts";

export function useAppBootstrap() {
  useLiveSessionEvents();
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const activeSessionView = useButlerStore(selectActiveSessionView);
  const rightAvailable = useButlerStore(selectRightAvailable);
  const setRightOpen = useButlerStore((state) => state.setRightOpen);
  const setNavigation = useButlerStore((state) => state.setNavigation);
  const setModelCatalog = useButlerStore((state) => state.setModelCatalog);
  const setModelCatalogState = useButlerStore(
    (state) => state.setModelCatalogState,
  );
  const setSettings = useButlerStore((state) => state.setSettings);
  const setMessages = useButlerStore((state) => state.setMessages);
  const setMessageListView = useButlerStore(
    (state) => state.setMessageListView,
  );
  const setSessionView = useButlerStore((state) => state.setSessionView);
  const setSummary = useButlerStore((state) => state.setSummary);
  const setTurnProgress = useButlerStore((state) => state.setTurnProgress);
  const setStatus = useButlerStore((state) => state.setStatus);
  const hydrateUiState = useButlerStore((state) => state.hydrateUiState);
  const messageCacheTimerRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const uiStateHydratedRef = useRef(false);
  const uiStateTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!rightAvailable) setRightOpen(false);
  }, [rightAvailable, setRightOpen]);

  useEffect(() => {
    let cancelled = false;
    async function restoreUiState() {
      try {
        const snapshot = await readCachedAppUiState();
        if (!cancelled && snapshot) hydrateUiState(snapshot);
      } finally {
        if (!cancelled) uiStateHydratedRef.current = true;
      }
    }
    restoreUiState();
    const unsubscribe = useButlerStore.subscribe((state, previous) => {
      if (!uiStateHydratedRef.current) return;
      const changed =
        state.activeChatId !== previous.activeChatId ||
        state.leftOpen !== previous.leftOpen ||
        state.rightOpen !== previous.rightOpen ||
        state.rightTab !== previous.rightTab ||
        state.leftPanelWidth !== previous.leftPanelWidth ||
        state.rightPanelWidth !== previous.rightPanelWidth ||
        state.sidebarChatsCollapsed !== previous.sidebarChatsCollapsed ||
        state.sidebarProjectsCollapsed !== previous.sidebarProjectsCollapsed ||
        state.sidebarCollapsedProjectIds !==
          previous.sidebarCollapsedProjectIds;
      if (!changed) return;
      if (uiStateTimerRef.current) clearTimeout(uiStateTimerRef.current);
      uiStateTimerRef.current = setTimeout(() => {
        const current = useButlerStore.getState();
        void writeCachedAppUiState({
          active_session_id: current.activeChatId,
          left_open: current.leftOpen,
          right_open: current.rightOpen,
          right_tab: current.rightTab,
          left_panel_width: current.leftPanelWidth,
          right_panel_width: current.rightPanelWidth,
          sidebar_chats_collapsed: current.sidebarChatsCollapsed,
          sidebar_projects_collapsed: current.sidebarProjectsCollapsed,
          sidebar_collapsed_project_ids: current.sidebarCollapsedProjectIds,
        });
      }, 250);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      if (uiStateTimerRef.current) clearTimeout(uiStateTimerRef.current);
    };
  }, [hydrateUiState]);

  useEffect(() => {
    const abortController = new AbortController();
    void recoverBootstrapResource({
      load: () => api<NavigationView>("/navigation"),
      onReady: setNavigation,
      onUnavailable: () => setNavigation(EMPTY_NAVIGATION),
      isCancelled: () => abortController.signal.aborted,
      signal: abortController.signal,
    });
    return () => {
      abortController.abort();
    };
  }, [setNavigation]);

  useEffect(() => {
    const abortController = new AbortController();
    void recoverBootstrapResource({
      load: () => api<ModelCatalogView>("/model-catalog"),
      onReady: setModelCatalog,
      onUnavailable: () => setModelCatalogState("error"),
      isCancelled: () => abortController.signal.aborted,
      signal: abortController.signal,
    });
    return () => {
      abortController.abort();
    };
  }, [setModelCatalog, setModelCatalogState]);

  useEffect(() => {
    const abortController = new AbortController();
    void recoverBootstrapResource({
      load: () => api<SettingsView>("/settings"),
      onReady: setSettings,
      onUnavailable: () => setSettings(readCachedSettings()),
      isCancelled: () => abortController.signal.aborted,
      signal: abortController.signal,
    });
    return () => {
      abortController.abort();
    };
  }, [setSettings]);

  useEffect(() => {
    void api("/updates/check", {
      method: "POST",
      body: JSON.stringify({ component: "app" }),
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadMessages() {
      if (!activeSessionView) return;
      if (isDraftChatId(activeChatId)) {
        setMessages([]);
        setSummary(null);
        setTurnProgress({});
        setStatus({ label: "ready", tone: "ok" });
        return;
      }
      if (!isServerBackedSessionId(activeChatId)) return;
      let cached: MessageListView | null = null;
      try {
        try {
          cached = await readCachedMessageList(activeChatId);
        } catch {
          // Cache reads are opportunistic; fall through to the server.
        }
        if (!cancelled && cached) {
          const cursor = messageListSyncCursor(cached);
          if (cursor > 0) {
            setMessageListView(cached);
            setStatus({ label: "ready", tone: "ok" });
          }
        }
        const data = await api<SessionView>(
          `/session-view?session_id=${encodeURIComponent(activeChatId)}`,
        );
        if (!cancelled) {
          const next: MessageListView = {
            chat_id: data.session_id,
            messages: data.messages,
            turn_progress: data.latest_turn?.id
              ? { [data.latest_turn.id]: {
                  ...data.latest_turn.progress,
                  started_at: data.latest_turn.created_at,
                } }
              : {},
            next_cursor: data.message_window.next_cursor,
            ...(data.message_window.next_cursor_token
              ? { next_cursor_token: data.message_window.next_cursor_token }
              : {}),
          };
          setSessionView(data);
          setStatus({ label: "ready", tone: "ok" });
          void writeCachedMessageList(activeChatId, next);
        }
      } catch (error) {
        if (!cancelled) {
          if (!cached) {
            notifyError(error, "Message load failed", {
              id: `message-load-${activeChatId}`,
            });
          }
          setStatus({ label: "ready", tone: "ok" });
        }
      }
    }
    loadMessages();
    return () => {
      cancelled = true;
    };
  }, [
    activeChatId,
    activeSessionView,
    setMessageListView,
    setMessages,
    setStatus,
    setSummary,
    setTurnProgress,
  ]);

  useEffect(() => {
    if (!activeSessionView || !isServerBackedSessionId(activeChatId)) return;
    const scheduleSave = () => {
      if (messageCacheTimerRef.current)
        clearTimeout(messageCacheTimerRef.current);
      messageCacheTimerRef.current = setTimeout(() => {
        const state = useButlerStore.getState();
        if (state.activeChatId !== activeChatId) return;
        void writeCachedMessageList(activeChatId, {
          chat_id: activeChatId,
          messages: state.messages,
          turn_progress: state.turnProgress,
        });
      }, 250);
    };
    const unsubscribe = useButlerStore.subscribe((state, previous) => {
      if (
        state.messages !== previous.messages ||
        state.turnProgress !== previous.turnProgress
      ) {
        scheduleSave();
      }
    });
    return () => {
      unsubscribe();
      if (messageCacheTimerRef.current)
        clearTimeout(messageCacheTimerRef.current);
    };
  }, [activeChatId, activeSessionView]);
}
