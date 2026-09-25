import type { MessageRecord, QueuedMessageRecord } from "@/app/types.ts";

export type QueuedConversationTone = "queued" | "sending" | "failed";

export interface QueuedConversationItem {
  key: string;
  record: QueuedMessageRecord;
  tone: QueuedConversationTone;
  /** 1-based place among waiting messages; 0 for failed sends. */
  position: number;
  /** Number of waiting (not failed) messages. */
  total: number;
  /** Stop the running turn so this message goes next (the queue head only). */
  canSendNow: boolean;
}

/** Stable across the optimistic record and the server record of one send. */
export function queuedMessageKey(record: QueuedMessageRecord): string {
  return record.client_message_id ?? record.id;
}

/** Queue records shown in the conversation after the messages, in queue order. */
export function queuedConversationItems({
  queue,
  messages,
  activeTurn,
  sendingNowKey,
}: {
  queue: readonly QueuedMessageRecord[];
  messages: readonly MessageRecord[];
  activeTurn: boolean;
  sendingNowKey: string | null;
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
    if (record.state === "failed") {
      return { key, record, tone: "failed", position: 0, total, canSendNow: false };
    }
    position += 1;
    return {
      key,
      record,
      tone: sendingNowKey === key ? "sending" : "queued",
      position,
      total,
      canSendNow: activeTurn && position === 1,
    };
  });
}
