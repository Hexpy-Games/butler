import type { MessageRecord } from "@/app/types.ts";
import type { LogTraceTarget } from "../settings/logs/traceApi.ts";

/** The trace behind a message: its turn's, else the persisted message's; none for a message not yet stored. */
export function messageTraceTarget(message: Pick<MessageRecord, "id" | "chat_id" | "turn_id">): LogTraceTarget | null {
  if (message.turn_id) return { turnId: message.turn_id };
  if (message.chat_id && message.id) return { chatId: message.chat_id, messageId: message.id };
  return null;
}
