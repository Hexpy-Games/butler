import { useCallback, useSyncExternalStore } from "react";
import { beginCanonQueueEdit, canonQueueSnapshot, editCanonQueue, getCanonQueue, observeCanonQueue } from "@/app/canonQueue.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { isServerBackedSessionId } from "@/app/sessionIds.ts";
import type { StepSortableEdit } from "@/butler-ds";
import { optimisticOrder, orderEditToApi, type OrderAction } from "./canonOrderModel.ts";

export function useSessionCanonQueue(sessionId: string) {
  const subscribe = useCallback((listener: () => void) => isServerBackedSessionId(sessionId)
    ? observeCanonQueue(sessionId, listener) : () => {}, [sessionId]);
  const snapshot = useCallback(() => canonQueueSnapshot(sessionId), [sessionId]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const edit = useCallback(async (change: StepSortableEdit | OrderAction) => {
    const before = canonQueueSnapshot(sessionId).view;
    if (!before) return;
    const drag = "type" in change;
    const input = orderEditToApi(before, change);
    const finish = beginCanonQueueEdit(sessionId, drag ? optimisticOrder(before, change) : before);
    if (!finish) return;
    let next = before;
    try { next = await editCanonQueue(sessionId, input); }
    catch (error) {
      if ((error as { status?: number }).status === 409) {
        try { next = await getCanonQueue(sessionId); notifyStatus(appCopy.canon.order.changed); }
        catch { notifyStatus(appCopy.canon.order.failed, { tone: "error" }); }
      } else notifyStatus(appCopy.canon.order.failed, { tone: "error" });
    } finally { finish(next); }
  }, [sessionId]);
  return { ...state, edit };
}
