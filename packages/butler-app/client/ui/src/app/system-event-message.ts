import { appCopy } from "./copy.ts";
import type { MessageRecord } from "./types.ts";

/** Event provenance, not translated text, determines compaction presentation. */
export function isCompactionMessage(message: MessageRecord): boolean {
  return message.role === "system_event" && (
    message.system_event_kind === "context.compaction.started" ||
    message.system_event_kind === "context.compaction.completed"
  );
}

export function visibleSystemMessageText(message: MessageRecord): string {
  if (!isCompactionMessage(message)) return message.text;
  return message.system_event_kind === "context.compaction.started"
    ? appCopy.interfaceFeedback.compacting
    : appCopy.interfaceFeedback.compacted;
}
