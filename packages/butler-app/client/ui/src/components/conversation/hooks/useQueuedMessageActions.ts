import { useCallback, useEffect, useState } from "react";
import { useButlerStore } from "@/app/store.ts";
import type { QueuedConversationItem } from "../queuedConversationItems";
import { loadQueuedMessageIntoComposer } from "./useComposerQueue";

/** A send-now request that has not delivered by then shows as queued again. */
const SEND_NOW_SETTLE_MS = 10_000;

/**
 * Actions of the queued rows in the conversation, mapped to the existing
 * queue API: edit loads the message into the composer and removes it from
 * the queue, delete removes it, and send now stops the running turn so the
 * gateway dispatches the queue head next.
 */
export function useQueuedMessageActions() {
  const [sendingNowKey, setSendingNowKey] = useState<string | null>(null);

  useEffect(() => {
    if (!sendingNowKey) return;
    const timer = window.setTimeout(() => setSendingNowKey(null), SEND_NOW_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [sendingNowKey]);

  const sendNow = useCallback((item: QueuedConversationItem) => {
    setSendingNowKey(item.key);
    void useButlerStore.getState().cancelActiveTurn();
  }, []);
  const edit = useCallback((item: QueuedConversationItem) => loadQueuedMessageIntoComposer(item.record), []);
  const remove = useCallback((item: QueuedConversationItem) => {
    void useButlerStore.getState().deleteQueuedMessage(item.record.id);
  }, []);

  return { sendingNowKey, sendNow, edit, remove };
}
