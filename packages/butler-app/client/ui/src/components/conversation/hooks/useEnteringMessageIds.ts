import { useEnteringKeys } from "@/butler-ds";
import type { MessageRecord } from "@/app/types.ts";

/** Sent and newly arrived rows fade in; opening a chat or scrolling does not. */
export function useEnteringMessageIds(messages: MessageRecord[], chatId: string | null): Set<string> {
  return useEnteringKeys(
    messages.map((message) => message.id),
    chatId ?? "",
    { enterOnScopeChange: (id) => isJustSentMessage(messages.find((message) => message.id === id)) },
  );
}

function isJustSentMessage(message: MessageRecord | undefined): boolean {
  return message?.role === "user" && message.status === "pending";
}
