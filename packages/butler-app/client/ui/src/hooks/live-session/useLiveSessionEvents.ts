import { appCopy } from "@/app/copy.ts";
import { useEffect, useRef } from "react";
import { subscribeLiveEvents } from "@/app/api.ts";
import { showDesktopNotification } from "@/app/nativeNotifications.ts";
import { useButlerStore } from "@/app/store.ts";
import type { TimelineEvent } from "@/app/types.ts";
import {
  LIVE_EVENT_STABLE_CONNECTION_MS,
  liveEventReconnectDelayMs,
} from "./liveEventReconnect.ts";
import {
  createLiveSessionReconciliation,
  eventSessionId,
  eventBelongsToCanonicalSessionView,
} from "./liveSessionReconciliation.ts";
import {
  applyLiveNavigationEvent,
  createLiveNavigationReconciliation,
  isProjectNavigationEvent,
} from "./liveNavigationReconciliation.ts";

const DESKTOP_NOTIFICATION_RECENT_WINDOW_MS = 60_000;
const TERMINAL_TURN_STATES = new Set(["delivered", "failed", "cancelled"]);

export function useLiveSessionEvents(): void {
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const projectedEventCursor = useButlerStore(
    (state) => state.sessionView?.cursors.events ?? 0,
  );
  const eventCursorRef = useRef(0);
  const activeChatIdRef = useRef(activeChatId);
  const notifiedMessageIdsRef = useRef(new Set<string>());
  const notifiedTurnIdsRef = useRef(new Set<string>());

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    eventCursorRef.current = Math.max(
      eventCursorRef.current,
      projectedEventCursor,
    );
  }, [projectedEventCursor]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stableConnectionTimer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;
    const reconciliation = createLiveSessionReconciliation(
      useButlerStore,
      () => activeChatIdRef.current,
    );
    const navigationReconciliation = createLiveNavigationReconciliation(
      useButlerStore,
    );

    const markStreamHealthy = () => {
      if (useButlerStore.getState().liveConnectionLost) {
        useButlerStore.setState({ liveConnectionLost: false });
      }
      consecutiveFailures = 0;
      if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
      stableConnectionTimer = undefined;
    };

    const applyEvent = (event: TimelineEvent) => {
      if (cancelled) return;
      markStreamHealthy();
      if (event.type === "stream.reconcile_required") {
        useButlerStore.getState().noteNavigationEvent();
        navigationReconciliation.noteLiveNavigationEvent();
        advanceEventCursor(eventCursorRef, event.id);
        navigationReconciliation.requestRefresh();
        reconciliation.requestRefresh();
        return;
      }
      const state = useButlerStore.getState();
      if (isProjectNavigationEvent(event)) {
        navigationReconciliation.noteLiveNavigationEvent();
        const nextNavigation = applyLiveNavigationEvent(state.navigation, event);
        if (nextNavigation !== state.navigation) {
          state.noteNavigationEvent();
          state.setNavigation(nextNavigation, { preserveOptimisticSession: false });
        } else {
          // A valid/stale/no-op live event still fences an in-flight bootstrap.
          // An absent project or absent updated row converges through the
          // bounded canonical load; stale updates for visible rows do not.
          state.noteNavigationEvent();
          const session = event.payload?.session;
          const projectId = session && typeof session === "object" && session !== null
            ? (session as { project_id?: unknown }).project_id
            : undefined;
          const sessionId = session && typeof session === "object" && session !== null
            ? (session as { id?: unknown }).id
            : undefined;
          const project = typeof projectId === "string"
            ? state.navigation.projects.find((item) => item.id === projectId)
            : undefined;
          const sessionKnown = typeof sessionId === "string" &&
            Boolean(project?.sessions?.some((item) => item.id === sessionId));
          const shouldRefresh =
            (event.type === "session.created" && !project) ||
            (event.type === "session.updated" && (!project || !sessionKnown));
          if (shouldRefresh) {
            // The bootstrap may still be empty; converge through the bounded canonical load.
            navigationReconciliation.requestRefresh();
          }
        }
      }
      if (
        event.type === "space.changed" || event.type === "session.created" ||
        event.type === "project.created" || event.type === "project.updated" ||
        event.type === "turn.state_changed" ||
        (event.type === "session.updated" && !isProjectNavigationEvent(event))
      ) {
        if (!isProjectNavigationEvent(event)) {
          state.noteNavigationEvent();
          navigationReconciliation.noteLiveNavigationEvent();
        }
        navigationReconciliation.requestRefresh();
      }
      navigationReconciliation.noteLiveEvent();
      state.applyTimelineEvents([event]);
      advanceEventCursor(eventCursorRef, event.id);
      notifyDesktopEvent(event, notifiedMessageIdsRef, notifiedTurnIdsRef);
      const activeSessionId = activeChatIdRef.current;
      const directChildSessionIds = directStewardChildSessionIds(
        state,
        activeSessionId,
      );
      const refreshesCanonicalParent = eventBelongsToCanonicalSessionView(
        event,
        activeSessionId,
        directChildSessionIds,
      );
      if (refreshesCanonicalParent) {
        reconciliation.requestRefresh();
        if (eventSessionId(event) !== activeSessionId) {
          navigationReconciliation.requestRefresh();
        }
      }
    };

    const connect = (reconnect = false) => {
      if (cancelled) return;
      if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
      stableConnectionTimer = setTimeout(() => {
        stableConnectionTimer = undefined;
        consecutiveFailures = 0;
      }, LIVE_EVENT_STABLE_CONNECTION_MS);
      if (reconnect) {
        navigationReconciliation.requestRefresh();
        reconciliation.requestRefresh();
      }
      const nextUnsubscribe = subscribeLiveEvents(
        eventCursorRef.current,
        applyEvent,
        () => {
          if (cancelled || reconnectTimer) return;
          useButlerStore.setState({ liveConnectionLost: true });
          if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
          stableConnectionTimer = undefined;
          unsubscribe?.();
          unsubscribe = undefined;
          const delayMs = liveEventReconnectDelayMs(consecutiveFailures);
          consecutiveFailures += 1;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            connect(true);
          }, delayMs);
        },
        () => {
          if (!cancelled) useButlerStore.setState({ liveConnectionLost: false });
        },
      );
      if (reconnectTimer) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;
    };

    connect();
    return () => {
      cancelled = true;
      useButlerStore.setState({ liveConnectionLost: false });
      unsubscribe?.();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconciliation.dispose();
      if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
      navigationReconciliation.dispose();
    };
  }, []);
}

function directStewardChildSessionIds(
  state: ReturnType<typeof useButlerStore.getState>,
  parentSessionId: string,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (state.summary?.session_id !== parentSessionId) return ids;
  for (const child of state.summary?.steward_children ?? []) {
    ids.add(child.session_id);
  }
  return ids;
}

function advanceEventCursor(cursorRef: { current: number }, id?: number): void {
  const eventId = Number(id);
  if (Number.isFinite(eventId)) {
    cursorRef.current = Math.max(cursorRef.current, eventId);
  }
}

function notifyDesktopEvent(
  event: TimelineEvent,
  messageIdsRef: { current: Set<string> },
  turnIdsRef: { current: Set<string> },
): void {
  const settings = useButlerStore.getState().settings.desktop_notifications;
  if (!settings.enabled || !isRecentEvent(event)) return;
  const message = event.payload?.message;
  if (
    settings.assistant_messages &&
    isDeliveredAssistantMessage(event) &&
    message?.id &&
    !messageIdsRef.current.has(message.id)
  ) {
    messageIdsRef.current.add(message.id);
    if (message.turn_id) turnIdsRef.current.add(message.turn_id);
    void showDesktopNotification({
      kind: "assistant_message",
      title: appCopy.firstRun.product,
      body: message.text || appCopy.interfaceTemplates.notificationNewMessage,
      sessionId: message.chat_id,
    });
  }
  const turn = event.payload?.turn;
  if (
    !settings.task_completions ||
    event.type !== "turn.state_changed" ||
    !turn?.id ||
    !TERMINAL_TURN_STATES.has(turn.state) ||
    turnIdsRef.current.has(turn.id)
  ) {
    return;
  }
  turnIdsRef.current.add(turn.id);
  void showDesktopNotification({
    kind: "task_completion",
    title: appCopy.firstRun.product,
    body: turnCompletionBody(turn.state, turn.safe_status_label),
    sessionId: turn.chat_id,
  });
}

function isRecentEvent(event: TimelineEvent): boolean {
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
  return Boolean(
    message?.role === "assistant" &&
    message.status !== "pending" &&
    message.status !== "streaming" &&
    message.status !== "retrying",
  );
}

function turnCompletionBody(state: string, safeStatusLabel?: string): string {
  if (safeStatusLabel?.trim()) return safeStatusLabel.trim();
  if (state === "delivered") return appCopy.interfaceTemplates.notificationCompleted;
  if (state === "failed") return appCopy.interfaceTemplates.notificationFailed;
  if (state === "cancelled") return appCopy.interfaceTemplates.notificationCancelled;
  return appCopy.interfaceTemplates.notificationUpdated;
}
