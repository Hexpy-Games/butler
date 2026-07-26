import { useEffect, useRef } from "react";
import { subscribeLiveEvents } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
import { showDesktopNotification } from "@/app/nativeNotifications.ts";
import { isServerBackedSessionId } from "@/app/sessionIds.ts";
import { useButlerStore } from "@/app/store.ts";
import type { TimelineEvent } from "@/app/types.ts";

const RECONNECT_DELAY_MS = 1_000;
const RECONCILE_SETTLE_MS = 100;
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
    let reconcileTimer: ReturnType<typeof setTimeout> | undefined;

    const reconcileActiveSession = () => {
      if (reconcileTimer) clearTimeout(reconcileTimer);
      reconcileTimer = setTimeout(() => {
        reconcileTimer = undefined;
        if (cancelled) return;
        void useButlerStore
          .getState()
          .refreshSessionView(activeChatIdRef.current);
      }, RECONCILE_SETTLE_MS);
    };

    const applyEvent = (event: TimelineEvent) => {
      if (cancelled) return;
      eventCursorRef.current = Math.max(
        eventCursorRef.current,
        Number(event.id ?? 0),
      );
      if (event.type === "stream.reconcile_required") {
        reconcileActiveSession();
        return;
      }
      const state = useButlerStore.getState();
      state.applyTimelineEvents([event]);
      notifyDesktopEvent(event, notifiedMessageIdsRef, notifiedTurnIdsRef);
      if (isTerminalEventForSession(event, activeChatIdRef.current)) {
        reconcileActiveSession();
      }
    };

    const connect = () => {
      if (cancelled) return;
      unsubscribe = subscribeLiveEvents(
        eventCursorRef.current,
        applyEvent,
        (error) => {
          if (cancelled) return;
          unsubscribe?.();
          reconcileActiveSession();
          notifyError(error, "Live updates paused", { id: "live-events" });
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        },
      );
    };

    connect();
    return () => {
      cancelled = true;
      unsubscribe?.();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (reconcileTimer) clearTimeout(reconcileTimer);
    };
  }, [shouldFollow]);
}

function isTerminalEventForSession(
  event: TimelineEvent,
  sessionId: string,
): boolean {
  const turn = event.payload?.turn;
  return Boolean(
    event.type === "turn.state_changed" &&
    turn?.chat_id === sessionId &&
    TERMINAL_TURN_STATES.has(turn.state),
  );
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
