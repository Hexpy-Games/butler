import type { ConversationMessage, QueuedMessageRecord } from "../../../butler-protocol/src/index.ts";

export interface QueuedConversationItem {
  key: string;
  record: QueuedMessageRecord;
  canSendNow: boolean;
  /** 1-based place among waiting messages; 0 for failed sends. */
  position: number;
  total: number;
}

export function queuedConversationItems(queue: readonly QueuedMessageRecord[], messages: readonly ConversationMessage[]): QueuedConversationItem[] {
  const shown = new Set(messages.map(message => message.id));
  const visible = queue.filter(record => !shown.has(record.id)
    && !(record.client_message_id && shown.has(record.client_message_id))
    && !(record.dispatched_message_id && shown.has(record.dispatched_message_id))
    && (record.state === "queued" || record.state === "failed"));
  const total = visible.filter(record => record.state !== "failed").length;
  let position = 0;
  return visible.map(record => {
    const key = record.client_message_id ?? record.id;
    if (record.state === "failed") return { key, record, canSendNow: false, position: 0, total };
    position += 1;
    return { key, record, canSendNow: position === 1, position, total };
  });
}
