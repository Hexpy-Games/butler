import { useEffect, useRef } from "react";
import { subscribeLiveEvents } from "@/app/api.ts";
import { showDesktopNotification } from "@/app/nativeNotifications.ts";
import { isServerBackedSessionId } from "@/app/sessionIds.ts";
import { useButlerStore } from "@/app/store.ts";
import type { TimelineEvent } from "@/app/types.ts";
import {
  LIVE_EVENT_STABLE_CONNECTION_MS,
  liveEventReconnectDelayMs,
} from "./liveEventReconnect.ts";
import {
  createLiveSessionReconciliation,
  eventSessionId,
  isSessionViewRefreshEvent,
} from "./liveSessionReconciliation.ts";

const DESKTOP_NOTIFICATION_RECENT_WINDOW_MS = 60_000;
const TERMINAL_TURN_STATES = new Set(["delivered", "failed", "cancelled"]);

export function useLiveSessionEvents(): void {
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const projectedSessionId = useButlerStore(
    (state) => state.sessionView?.session_id ?? "",
  );
  const projectedEventCursor = useButlerStore(
    (state) => state.sessionView?.cursors.events ?? 0,
  );
  const eventCursorRef = useRef(0);
  const activeChatIdRef = useRef(activeChatId);
  const notifiedMessageIdsRef = useRef(new Set<string>());
  const notifiedTurnIdsRef = useRef(new Set<string>());
  const shouldFollow =
    isServerBackedSessionId(activeChatId) &&
    projectedSessionId === activeChatId;

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
    if (!shouldFollow) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stableConnectionTimer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;
    const reconciliation = createLiveSessionReconciliation(
      useButlerStore,
      () => activeChatIdRef.current,
    );

    const markStreamHealthy = () => {
      consecutiveFailures = 0;
      if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
      stableConnectionTimer = undefined;
    };

    const applyEvent = (event: TimelineEvent) => {
      if (cancelled) return;
      markStreamHealthy();
      if (event.type === "stream.reconcile_required") {
        advanceEventCursor(eventCursorRef, event.id);
        reconciliation.requestRefresh();
        return;
      }
      const state = useButlerStore.getState();
      state.applyTimelineEvents([event]);
      advanceEventCursor(eventCursorRef, event.id);
      notifyDesktopEvent(event, notifiedMessageIdsRef, notifiedTurnIdsRef);
      if (
        isSessionViewRefreshEvent(event) &&
        eventSessionId(event) === activeChatIdRef.current
      ) {
        reconciliation.requestRefresh();
      }
    };

    const connect = (reconnect = false) => {
      if (cancelled) return;
      if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
      stableConnectionTimer = setTimeout(() => {
        stableConnectionTimer = undefined;
        consecutiveFailures = 0;
      }, LIVE_EVENT_STABLE_CONNECTION_MS);
      if (reconnect) reconciliation.requestRefresh();
      const nextUnsubscribe = subscribeLiveEvents(
        eventCursorRef.current,
        applyEvent,
        () => {
          if (cancelled || reconnectTimer) return;
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
      );
      if (reconnectTimer) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;
    };

    connect();
    if (useButlerStore.getState().sessionView?.active_turn) {
      reconciliation.requestRefresh();
    }
    reconciliation.startActiveTurnPolling();
    return () => {
      cancelled = true;
      unsubscribe?.();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconciliation.dispose();
      if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
    };
  }, [activeChatId, shouldFollow]);
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
      title: "Butler",
      body: message.text || "새 메시지가 도착했습니다.",
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
    title: "Butler",
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
  if (state === "delivered") return "작업이 완료되었습니다.";
  if (state === "failed") return "작업이 실패했습니다.";
  if (state === "cancelled") return "작업이 취소되었습니다.";
  return "작업 상태가 업데이트되었습니다.";
}
