import { useCallback, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { apiErrorCode } from "@/app/api.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { useButlerStore } from "@/app/store.ts";
import type { QueuedConversationItem } from "../queuedConversationItems";
import { loadQueuedMessageIntoComposer } from "./useComposerQueue";

/** Queue controls and the pending Send now keys, stable across server record replacement. */
export function useQueuedMessageActions() {
  const pending = useRef(new Set<string>());
  const [sendingKeys, setSendingKeys] = useState<ReadonlySet<string>>(new Set());
  const clearMissing = useCallback((keys: readonly string[]) => {
    const visible = new Set(keys);
    const removed = [...pending.current].filter(key => !visible.has(key));
    if (!removed.length) return;
    for (const key of removed) pending.current.delete(key);
    setSendingKeys(new Set(pending.current));
  }, []);
  const edit = useCallback((item: QueuedConversationItem) => loadQueuedMessageIntoComposer(item.record), []);
  const remove = useCallback((item: QueuedConversationItem) => {
    void useButlerStore.getState().deleteQueuedMessage(item.record.id);
  }, []);
  const sendNow = useCallback(async (item: QueuedConversationItem) => {
    if (!item.canSendNow || item.tone !== "queued" || pending.current.has(item.key)) return;
    pending.current.add(item.key);
    setSendingKeys(new Set(pending.current));
    try {
      await useButlerStore.getState().sendQueuedMessageNow(item.record.id);
    } catch (error) {
      if (apiErrorCode(error) !== "queued_message_not_next") {
        notifyStatus(appCopy.composer.sendNowFailed, { tone: "error" });
      }
      await useButlerStore.getState().refreshSessionQueue(item.record.chat_id);
      pending.current.delete(item.key);
      setSendingKeys(new Set(pending.current));
    }
  }, []);
  return { edit, remove, sendNow, sendingKeys, clearMissing };
}
