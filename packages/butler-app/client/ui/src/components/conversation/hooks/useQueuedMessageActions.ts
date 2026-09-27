import { useCallback } from "react";
import { useButlerStore } from "@/app/store.ts";
import type { QueuedConversationItem } from "../queuedConversationItems";
import { loadQueuedMessageIntoComposer } from "./useComposerQueue";

/**
 * Actions of the queued rows in the conversation, mapped to the existing
 * queue API: edit loads the message into the composer and removes it from
 * the queue, delete removes it.
 */
export function useQueuedMessageActions() {
  const edit = useCallback((item: QueuedConversationItem) => loadQueuedMessageIntoComposer(item.record), []);
  const remove = useCallback((item: QueuedConversationItem) => {
    void useButlerStore.getState().deleteQueuedMessage(item.record.id);
  }, []);
  return { edit, remove };
}
