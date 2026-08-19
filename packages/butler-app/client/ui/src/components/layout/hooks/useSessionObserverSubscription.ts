import { useEffect } from "react";

const SESSION_OBSERVER_REFRESH_INTERVAL_MS = 2_000;

interface SessionObserverTimerApi {
  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

function createSessionObserverSubscription(
  sessionId: string,
  refresh: (sessionId: string) => Promise<unknown> | unknown,
  timers: SessionObserverTimerApi = window,
): () => void {
  let disposed = false;
  let requestInFlight = false;
  const request = () => {
    if (disposed || requestInFlight) return;
    requestInFlight = true;
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(refresh(sessionId));
    } catch (error) {
      result = Promise.reject(error);
    }
    void result
      .catch(() => undefined)
      .finally(() => {
        requestInFlight = false;
      });
  };
  request();
  const timer = timers.setInterval(request, SESSION_OBSERVER_REFRESH_INTERVAL_MS);
  return () => {
    disposed = true;
    timers.clearInterval(timer);
  };
}

export function useSessionObserverSubscription(
  sessionId: string | null,
  refresh: (sessionId: string) => Promise<unknown> | unknown,
): void {
  useEffect(() => {
    if (!sessionId) return;
    return createSessionObserverSubscription(sessionId, refresh);
  }, [refresh, sessionId]);
}
