import type { MessageRecord, QueuedMessageRecord } from "@/app/types.ts";

export type QueuedConversationTone = "queued" | "sending" | "failed";

export interface QueuedConversationItem {
  key: string;
  record: QueuedMessageRecord;
  tone: QueuedConversationTone;
  canSendNow: boolean;
  /** 1-based place among waiting messages; 0 for failed sends. */
  position: number;
  /** Number of waiting (not failed) messages. */
  total: number;
}

/** Stable across the optimistic record and the server record of one send. */
export function queuedMessageKey(record: QueuedMessageRecord): string {
  return record.client_message_id ?? record.id;
}

/** Queue records shown after the messages, preserving waiting order while sending. */
export function queuedConversationItems({
  queue,
  messages,
  sendingKeys = new Set<string>(),
}: {
  queue: readonly QueuedMessageRecord[];
  messages: readonly MessageRecord[];
  sendingKeys?: ReadonlySet<string>;
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
    if (record.state === "failed") return { key, record, tone: "failed", canSendNow: false, position: 0, total };
    position += 1;
    return { key, record, tone: sendingKeys.has(key) ? "sending" : "queued", canSendNow: position === 1, position, total };
  });
}
