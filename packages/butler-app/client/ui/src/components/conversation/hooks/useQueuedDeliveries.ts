import { useCallback, useRef } from "react";

/**
 * Remembers which queue keys (client message ids) were shown as queued rows
 * in this chat, so the user message that later arrives with the same id
 * resolves from the queued bubble instead of entering as a new message.
 */
export function useQueuedDeliveries(queuedKeys: readonly string[], chatId: string): (messageId: string) => boolean {
  const state = useRef<{ chatId: string; seen: Set<string> }>({ chatId, seen: new Set() });
  if (state.current.chatId !== chatId) state.current = { chatId, seen: new Set() };
  for (const key of queuedKeys) state.current.seen.add(key);
  return useCallback((messageId: string) => state.current.seen.has(messageId), []);
}
