import { useMemo } from "react";
import { useButlerStore } from "@/app/store.ts";
import type { MessageRecord } from "@/app/types.ts";
import { useEnteringKeys } from "@/butler-ds";
import { queuedConversationItems, type QueuedConversationItem } from "../queuedConversationItems";
import { useQueuedDeliveries } from "./useQueuedDeliveries";
import { useQueuedMessageActions } from "./useQueuedMessageActions";

export interface QueuedConversation {
  items: QueuedConversationItem[];
  keys: string[];
  entering: Set<string>;
  /** A message whose id was shown as a queued row resolves from it. */
  wasQueued: (messageId: string) => boolean;
  actions: ReturnType<typeof useQueuedMessageActions>;
}

/** Queued follow-ups of the active chat as conversation rows (after the messages). */
export function useQueuedConversation(
  visibleMessages: MessageRecord[],
  activeChatId: string,
  activeTurn: boolean,
): QueuedConversation {
  const sessionQueue = useButlerStore((state) => state.sessionQueue);
  const actions = useQueuedMessageActions();
  const items = useMemo(() => queuedConversationItems({
    queue: sessionQueue.filter((record) => record.chat_id === activeChatId),
    messages: visibleMessages,
    activeTurn,
    sendingNowKey: actions.sendingNowKey,
  }), [actions.sendingNowKey, activeChatId, activeTurn, sessionQueue, visibleMessages]);
  const keys = useMemo(() => items.map((item) => item.key), [items]);
  const entering = useEnteringKeys(keys, activeChatId);
  const wasQueued = useQueuedDeliveries(keys, activeChatId);
  return { items, keys, entering, wasQueued, actions };
}
