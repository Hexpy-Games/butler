import type { MessageRecord, QueuedMessageRecord } from "@/app/types.ts";

export type QueuedConversationTone = "queued" | "failed";

export interface QueuedConversationItem {
  key: string;
  record: QueuedMessageRecord;
  tone: QueuedConversationTone;
  /** 1-based place among waiting messages; 0 for failed sends. */
  position: number;
  /** Number of waiting (not failed) messages. */
  total: number;
}

/** Stable across the optimistic record and the server record of one send. */
export function queuedMessageKey(record: QueuedMessageRecord): string {
  return record.client_message_id ?? record.id;
}

/**
 * Queue records shown in the conversation after the messages, in queue order.
 * "Send now" is not offered until the gateway can dispatch a queued message
 * immediately (owner decision; the DS QueuedMessage keeps the capability).
 */
export function queuedConversationItems({
  queue,
  messages,
}: {
  queue: readonly QueuedMessageRecord[];
  messages: readonly MessageRecord[];
}): QueuedConversationItem[] {
  const shown = new Set(messages.map((message) => message.id));
  const visible = queue.filter((record) =>
    !shown.has(queuedMessageKey(record)) &&
    !(record.dispatched_message_id && shown.has(record.dispatched_message_id)) &&
    (record.state === "queued" || record.state === "failed"));
  const total = visible.filter((record) => record.state !== "failed").length;
  let position = 0;
  return visible.map((record) => {
    const key = queuedMessageKey(record);
    if (record.state === "failed") return { key, record, tone: "failed", position: 0, total };
    position += 1;
    return { key, record, tone: "queued", position, total };
  });
}
