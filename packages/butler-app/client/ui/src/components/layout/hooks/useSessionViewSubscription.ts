import { useEffect } from "react";
import type { TimelineEvent } from "@/app/types.ts";
import { createLiveSessionReconciliation, eventSessionId, isSessionViewRefreshEvent } from
  "@/hooks/live-session/liveSessionReconciliation.ts";

const subscriptions = new Set<{
  sessionId: string; read: (id: string) => unknown; users: number;
  refresh: (immediate?: boolean) => void; dispose: () => void;
}>();

/** All mounted observers, including conversation cards, consume the App stream. */
export function refreshSessionViewSubscriptions(event?: TimelineEvent): void {
  if (event && !isSessionViewRefreshEvent(event) && event.type !== "stream.reconcile_required") return;
  for (const subscription of subscriptions) {
    if (!event || event.type === "stream.reconcile_required" ||
        eventSessionId(event) === subscription.sessionId ||
        event.payload?.child_session_id === subscription.sessionId) {
      subscription.refresh(!event || event.type === "subsession.changed");
    }
  }
}

/** Initial canonical snapshot plus bounded, change-driven live reconciliation. */
export function useSessionViewSubscription(
  sessionId: string | null,
  refresh: (sessionId: string) => Promise<unknown> | unknown,
): void {
  useEffect(() => {
    if (!sessionId) return;
    let subscription = [...subscriptions].find(item => item.sessionId === sessionId && item.read === refresh);
    if (!subscription) {
      const reconciliation = createLiveSessionReconciliation({ getState: () => ({
        activeChatId: sessionId,
        sessionView: { session_id: sessionId },
        refreshSessionView: async id => refresh(id),
      }) }, () => sessionId);
      subscription = { sessionId, read: refresh, users: 0, refresh: reconciliation.requestRefresh, dispose: reconciliation.dispose };
      subscriptions.add(subscription);
      subscription.refresh(true);
    }
    subscription.users++;
    const current = subscription;
    return () => {
      if (--current.users === 0) { subscriptions.delete(current); current.dispose(); }
    };
  }, [refresh, sessionId]);
}
