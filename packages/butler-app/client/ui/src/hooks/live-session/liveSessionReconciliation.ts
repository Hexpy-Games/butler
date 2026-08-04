import type { TimelineEvent } from "@/app/types.ts";

const SESSION_VIEW_REFRESH_INTERVAL_MS = 1_000;

const SESSION_VIEW_REFRESH_EVENT_TYPES = new Set([
  "message.created",
  "message.updated",
  "message.deleted",
  "turn.state_changed",
  "turn.progress",
  "turn.queued",
  "turn.queue_failed",
  "agent.turn_event",
  "agent.turn_event.progress",
  "progress.summary",
  "session.controls_updated",
  "session.control.updated",
  "session_queue.changed",
  "session.queue.changed",
]);

interface SessionViewState {
  activeChatId: string;
  sessionView?: {
    session_id?: string;
    active_turn?: unknown | null;
  } | null;
  refreshSessionView: (
    sessionId: string,
    options?: { isCurrent?: () => boolean },
  ) => Promise<unknown>;
}

interface ReconciliationStore {
  getState: () => SessionViewState;
}

export interface LiveSessionReconciliation {
  requestRefresh(): void;
  startActiveTurnPolling(): void;
  dispose(): void;
}

export function createLiveSessionReconciliation(
  store: ReconciliationStore,
  sessionId: () => string,
): LiveSessionReconciliation {
  let disposed = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let activeTurnTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshInFlight = false;
  let refreshDirty = false;
  let refreshPhase: "idle" | "leading" | "trailing" = "idle";
  let lastRefreshStartedAt = 0;
  let refreshRequestToken = 0;

  const isCurrentSession = () => {
    const state = store.getState();
    const currentSessionId = sessionId();
    return !disposed &&
      state.activeChatId === currentSessionId &&
      state.sessionView?.session_id === currentSessionId;
  };

  const refreshWhenDue = () => {
    refreshTimer = undefined;
    if (!isCurrentSession()) {
      refreshDirty = false;
      refreshPhase = "idle";
      return;
    }
    if (refreshInFlight) {
      refreshDirty = true;
      return;
    }
    const remainingMs = Math.max(
      0,
      lastRefreshStartedAt + SESSION_VIEW_REFRESH_INTERVAL_MS - Date.now(),
    );
    if (remainingMs > 0) {
      refreshTimer = setTimeout(refreshWhenDue, remainingMs);
      return;
    }

    const currentSessionId = sessionId();
    refreshDirty = false;
    const startedRefreshToken = ++refreshRequestToken;
    refreshInFlight = true;
    lastRefreshStartedAt = Date.now();
    Promise.resolve()
      .then(
        () =>
          store.getState().refreshSessionView(currentSessionId, {
            isCurrent: () =>
              !disposed &&
              startedRefreshToken === refreshRequestToken &&
              isCurrentSession(),
          }),
      )
      .catch(() => false)
      .finally(() => {
        refreshInFlight = false;
        if (
          disposed ||
          startedRefreshToken !== refreshRequestToken ||
          !isCurrentSession()
        ) {
          refreshDirty = false;
          refreshPhase = "idle";
          return;
        }
        if (refreshDirty) {
          refreshPhase = "trailing";
          refreshWhenDue();
          return;
        }
        // Every leading refresh gets one bounded follow-up so terminal events
        // are reconciled even when no second event arrives on the stream.
        if (refreshPhase === "leading") {
          refreshPhase = "trailing";
          refreshWhenDue();
        } else {
          refreshPhase = "idle";
        }
      });
  };

  const requestRefresh = () => {
    if (!isCurrentSession()) return;
    refreshDirty = true;
    if (refreshPhase === "idle") refreshPhase = "leading";
    if (refreshInFlight || refreshTimer) return;
    refreshWhenDue();
  };

  const pollActiveTurn = () => {
    activeTurnTimer = undefined;
    if (disposed) return;
    const state = store.getState();
    const currentSessionId = sessionId();
    if (
      state.activeChatId === currentSessionId &&
      state.sessionView?.session_id === currentSessionId &&
      state.sessionView.active_turn
    ) {
      requestRefresh();
    }
    activeTurnTimer = setTimeout(
      pollActiveTurn,
      SESSION_VIEW_REFRESH_INTERVAL_MS,
    );
  };

  return {
    requestRefresh,
    startActiveTurnPolling() {
      activeTurnTimer = setTimeout(
        pollActiveTurn,
        SESSION_VIEW_REFRESH_INTERVAL_MS,
      );
    },
    dispose() {
      disposed = true;
      refreshRequestToken += 1;
      refreshDirty = false;
      refreshPhase = "idle";
      if (refreshTimer) clearTimeout(refreshTimer);
      if (activeTurnTimer) clearTimeout(activeTurnTimer);
      refreshTimer = undefined;
      activeTurnTimer = undefined;
    },
  };
}

export function isSessionViewRefreshEvent(event: TimelineEvent): boolean {
  return SESSION_VIEW_REFRESH_EVENT_TYPES.has(event.type) ||
    event.type.startsWith("turn.progress.") ||
    event.type.startsWith("session.control") ||
    event.type.startsWith("session_queue.") ||
    event.type.startsWith("session.queue.") ||
    event.type.startsWith("worker.") ||
    event.type.startsWith("worker_");
}

export function eventSessionId(event: TimelineEvent): string | undefined {
  const payload = event.payload;
  if (
    event.type === "agent.turn_event" ||
    event.type === "agent.turn_event.progress" ||
    event.type === "progress.summary"
  ) {
    return payload?.session_id;
  }
  return payload?.chat_id ??
    payload?.session_id ??
    payload?.turn?.chat_id ??
    payload?.message?.chat_id;
}
