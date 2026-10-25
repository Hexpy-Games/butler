import { useCallback, useSyncExternalStore } from "react";
import { observePendingAsks, pendingAsksSnapshot } from "@/app/pendingAsks.ts";
import { isServerBackedSessionId } from "@/app/sessionIds.ts";

export function usePendingAsks(sessionId: string) {
  const subscribe = useCallback((listener: () => void) => isServerBackedSessionId(sessionId)
    ? observePendingAsks(sessionId, listener) : () => {}, [sessionId]);
  const snapshot = useCallback(() => pendingAsksSnapshot(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
