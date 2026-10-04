import { useEffect } from "react";

/** Initial canonical snapshot; subsequent changes ride the App event stream. */
export function useSessionViewSubscription(
  sessionId: string | null,
  refresh: (sessionId: string) => Promise<unknown> | unknown,
): void {
  useEffect(() => {
    if (sessionId) void Promise.resolve(refresh(sessionId)).catch(() => undefined);
  }, [refresh, sessionId]);
}
