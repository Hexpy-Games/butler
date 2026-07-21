import { useEffect, useRef } from "react";
import { api, subscribeLiveEvents } from "@/app/api.ts";
import {
  ACTIVE_TURN_STATES,
  EMPTY_NAVIGATION,
} from "@/app/constants.ts";
import {
  messageListSyncCursor,
  readCachedMessageList,
  readCachedMessageListSync,
  writeCachedMessageList,
} from "@/app/messageCache.ts";
import {
  readCachedAppUiState,
  writeCachedAppUiState,
} from "@/app/appUiStateCache.ts";
import { readCachedSettings } from "@/app/settingsCache.ts";
import { notifyError } from "@/app/notifications.ts";
import { showDesktopNotification } from "@/app/nativeNotifications.ts";
import { hasFollowableWorkerActivity, isDraftChatId } from "@/app/utils.ts";
import { isServerBackedSessionId } from "@/app/sessionIds.ts";
import { recoverBootstrapResource } from "@/hooks/bootstrapResource.ts";
import {
  selectActiveSessionView,
  selectRightAvailable,
  useButlerStore,
} from "@/app/store.ts";
import type {
  MessageListView,
  ModelCatalogView,
  NavigationView,
  SessionSummaryView,
  SessionView,
  SettingsView,
  TimelineEvent,
} from "@/app/types.ts";

const SESSION_SUMMARY_ACTIVE_REFRESH_MS = 1_200;
const EVENT_REPLAY_RETRY_MS = 5_000;
const EVENT_REPLAY_ACTIVE_REFRESH_MS = 2_500;
const LIVE_EVENT_SESSION_REFRESH_DEBOUNCE_MS = 250;
const DESKTOP_NOTIFICATION_RECENT_WINDOW_MS = 60_000;
const TERMINAL_TURN_STATES = new Set(["delivered", "failed", "cancelled"]);

function hasCompleteCachedSession(chatId: string): boolean {
  const cached = readCachedMessageListSync(chatId);
  return Boolean(cached && messageListSyncCursor(cached) > 0);
}

function hasFollowableWorkers(
  summary: SessionSummaryView | null | undefined,
): boolean {
  return hasFollowableWorkerActivity(summary?.worker_activity);
}

function targetsActiveChat(
  event: TimelineEvent,
  activeChatId: string,
): boolean {
  const payload = event.payload;
  return Boolean(
    payload?.session_id === activeChatId ||
    payload?.message?.chat_id === activeChatId ||
    payload?.turn?.chat_id === activeChatId ||
    payload?.event?.sessionId === activeChatId,
  );
}

function isRecentDesktopEvent(event: TimelineEvent): boolean {
  const createdAt = Date.parse(event.created_at ?? "");
  if (!Number.isFinite(createdAt)) return false;
  const ageMs = Date.now() - createdAt;
  return ageMs >= -5_000 && ageMs <= DESKTOP_NOTIFICATION_RECENT_WINDOW_MS;
}

function isDeliveredAssistantMessage(event: TimelineEvent): boolean {
  if (event.type !== "message.created" && event.type !== "message.updated") {
    return false;
  }
  const message = event.payload?.message;
  return (
    message?.role === "assistant" &&
    message.status !== "pending" &&
    message.status !== "streaming" &&
    message.status !== "retrying"
  );
}

function turnCompletionBody(state: string, safeStatusLabel?: string): string {
  if (safeStatusLabel?.trim()) return safeStatusLabel.trim();
  if (state === "delivered") return "작업이 완료되었습니다.";
  if (state === "failed") return "작업이 실패했습니다.";
  if (state === "cancelled") return "작업이 취소되었습니다.";
  return "작업 상태가 업데이트되었습니다.";
}

export function useAppBootstrap() {
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const activeSessionView = useButlerStore(selectActiveSessionView);
  const rightAvailable = useButlerStore(selectRightAvailable);
  const isSending = useButlerStore((state) => state.isSending);
  const sendingChatId = useButlerStore((state) => state.sendingChatId);
  const sendingOperations = useButlerStore((state) => state.sendingOperations);
  const summaryTurnState = useButlerStore(
    (state) => state.summary?.turn_state ?? "",
  );
  const summarySessionId = useButlerStore(
    (state) => state.summary?.session_id ?? "",
  );
  const activeWorkerVisible = useButlerStore((state) =>
    hasFollowableWorkers(state.summary),
  );
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
  const applyTimelineEvents = useButlerStore(
    (state) => state.applyTimelineEvents,
  );
  const refreshSessionView = useButlerStore(
    (state) => state.refreshSessionView,
  );
  const setSummary = useButlerStore((state) => state.setSummary);
  const setTurnProgress = useButlerStore((state) => state.setTurnProgress);
  const setStatus = useButlerStore((state) => state.setStatus);
  const hydrateUiState = useButlerStore((state) => state.hydrateUiState);
  const eventCursorRef = useRef(0);
  const eventPollingRef = useRef(false);
  const messageCacheTimerRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const desktopNotifiedMessageIdsRef = useRef<Set<string>>(new Set());
  const desktopNotifiedTurnIdsRef = useRef<Set<string>>(new Set());
  const uiStateHydratedRef = useRef(false);
  const uiStateTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const activeSessionSending =
    isSending &&
    (sendingChatId === activeChatId ||
      Object.values(sendingOperations).includes(activeChatId));
  const activeTurnVisible = ACTIVE_TURN_STATES.has(summaryTurnState);
  const shouldFollowSessionEvents =
    Boolean(activeSessionView) && isServerBackedSessionId(activeChatId);

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
    eventCursorRef.current = 0;
  }, [activeChatId]);

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
              ? { [data.latest_turn.id]: data.latest_turn.progress }
              : {},
            next_cursor: data.message_window.next_cursor,
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

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function loadSessionSummary() {
      if (!activeSessionView || !isServerBackedSessionId(activeChatId)) return;
      if (
        !activeSessionSending &&
        !activeTurnVisible &&
        !activeWorkerVisible &&
        summarySessionId === activeChatId &&
        hasCompleteCachedSession(activeChatId)
      ) {
        return;
      }
      try {
        const data = await api<SessionView>(
          `/session-view?session_id=${encodeURIComponent(activeChatId)}`,
        );
        if (!cancelled) {
          setSessionView(data);
          const state = data.latest_turn?.state ?? "idle";
          if (
            ACTIVE_TURN_STATES.has(state) ||
            activeSessionSending ||
            hasFollowableWorkerActivity(data.workers)
          ) {
            timer = setTimeout(
              loadSessionSummary,
              SESSION_SUMMARY_ACTIVE_REFRESH_MS,
            );
          }
        }
      } catch {
        // Preserve the previous summary on transient failures so idle refresh
        // retries do not visibly clear and refill progress or inspector panels.
      } finally {
        if (!cancelled && activeSessionSending && !timer) {
          timer = setTimeout(
            loadSessionSummary,
            SESSION_SUMMARY_ACTIVE_REFRESH_MS,
          );
        }
      }
    }
    loadSessionSummary();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    activeChatId,
    activeSessionSending,
    activeSessionView,
    activeTurnVisible,
    activeWorkerVisible,
    setSummary,
  ]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sessionRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeLiveEvents: (() => void) | undefined;
    let liveFailed = false;
    const scheduleSessionRefresh = (events: TimelineEvent[]) => {
      if (!events.some((event) => targetsActiveChat(event, activeChatId))) {
        return;
      }
      if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
      sessionRefreshTimer = setTimeout(() => {
        sessionRefreshTimer = undefined;
        if (!cancelled) void refreshSessionView(activeChatId);
      }, LIVE_EVENT_SESSION_REFRESH_DEBOUNCE_MS);
    };
    const notifyDesktopTimelineEvents = (events: TimelineEvent[]) => {
      const notificationSettings =
        useButlerStore.getState().settings.desktop_notifications;
      if (!notificationSettings.enabled) return;
      const assistantTurnIds = new Set<string>();
      if (notificationSettings.assistant_messages) {
        for (const event of events) {
          if (!isRecentDesktopEvent(event) || !isDeliveredAssistantMessage(event)) {
            continue;
          }
          const message = event.payload?.message;
          if (!message?.id || desktopNotifiedMessageIdsRef.current.has(message.id)) {
            continue;
          }
          desktopNotifiedMessageIdsRef.current.add(message.id);
          if (message.turn_id) assistantTurnIds.add(message.turn_id);
          void showDesktopNotification({
            kind: "assistant_message",
            title: "Butler",
            body: message.text || "새 메시지가 도착했습니다.",
            sessionId: message.chat_id,
          });
        }
      }
      if (!notificationSettings.task_completions) return;
      for (const event of events) {
        if (!isRecentDesktopEvent(event) || event.type !== "turn.state_changed") {
          continue;
        }
        const turn = event.payload?.turn;
        if (!turn?.id || !TERMINAL_TURN_STATES.has(turn.state)) continue;
        if (
          turn.state === "delivered" &&
          notificationSettings.assistant_messages &&
          assistantTurnIds.has(turn.id)
        ) {
          continue;
        }
        if (desktopNotifiedTurnIdsRef.current.has(turn.id)) continue;
        desktopNotifiedTurnIdsRef.current.add(turn.id);
        void showDesktopNotification({
          kind: "task_completion",
          title: "Butler",
          body: turnCompletionBody(turn.state, turn.safe_status_label),
          sessionId: turn.chat_id,
        });
      }
    };
    const applyEvents = (events: TimelineEvent[], nextCursor?: number) => {
      applyTimelineEvents(events);
      notifyDesktopTimelineEvents(events);
      const maxEventCursor = events.reduce((max, event) => {
        const cursor = Number(event.id ?? 0);
        return Number.isFinite(cursor) && cursor > max ? cursor : max;
      }, eventCursorRef.current);
      eventCursorRef.current = Math.max(
        eventCursorRef.current,
        maxEventCursor,
        Number(nextCursor ?? 0),
      );
      const currentState = useButlerStore.getState();
      const activeSessionSending =
        currentState.isSending &&
        (currentState.sendingChatId === activeChatId ||
          Object.values(currentState.sendingOperations).includes(activeChatId));
      if (!activeSessionSending) {
        setStatus({ label: "ready", tone: "ok" });
      }
      scheduleSessionRefresh(events);
    };
    async function pollEvents() {
      if (
        !activeSessionView ||
        !shouldFollowSessionEvents
      ) {
        return;
      }
      if (eventPollingRef.current) {
        timer = setTimeout(pollEvents, EVENT_REPLAY_RETRY_MS);
        return;
      }
      eventPollingRef.current = true;
      try {
        const data = await api<{
          events: TimelineEvent[];
          next_cursor: number;
        }>(`/events?cursor=${eventCursorRef.current}`);
        if (!cancelled) {
          applyEvents(data.events, data.next_cursor);
        }
      } catch (error) {
        if (!cancelled) {
          notifyError(error, "Event replay failed", { id: "event-replay" });
          setStatus({ label: "ready", tone: "ok" });
        }
      } finally {
        eventPollingRef.current = false;
        if (!cancelled) {
          timer = setTimeout(pollEvents, EVENT_REPLAY_ACTIVE_REFRESH_MS);
        }
      }
    }
    if (
      activeSessionView &&
      shouldFollowSessionEvents
    ) {
      unsubscribeLiveEvents = subscribeLiveEvents(
        eventCursorRef.current,
        (event) => {
          if (cancelled) return;
          applyEvents([event]);
        },
        () => {
          if (cancelled || liveFailed) return;
          liveFailed = true;
          unsubscribeLiveEvents?.();
          timer = setTimeout(pollEvents, EVENT_REPLAY_RETRY_MS);
        },
      );
    } else {
      if (shouldFollowSessionEvents) {
        timer = setTimeout(pollEvents, EVENT_REPLAY_RETRY_MS);
      }
    }
    return () => {
      cancelled = true;
      eventPollingRef.current = false;
      unsubscribeLiveEvents?.();
      if (timer) clearTimeout(timer);
      if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
    };
  }, [
    activeChatId,
    activeSessionSending,
    activeSessionView,
    applyTimelineEvents,
    refreshSessionView,
    setStatus,
    shouldFollowSessionEvents,
  ]);
}
