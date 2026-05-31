import type { MessageRecord } from "@/app/types.ts";

export interface AssistantFooterMeta {
  durationLabel: string | null;
  timeLabel: string | null;
  completedAtIso: string | null;
}

export function buildAssistantFooterMetaById(
  messages: MessageRecord[],
): Map<string, AssistantFooterMeta> {
  const metaById = new Map<string, AssistantFooterMeta>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    metaById.set(
      message.id,
      assistantFooterMeta(message, findTurnUserMessage(messages, index, message.turn_id)),
    );
  }
  return metaById;
}

function assistantFooterMeta(
  message: MessageRecord,
  userMessage: MessageRecord | undefined,
): AssistantFooterMeta {
  const completedAt = parseMessageDate(message.updated_at ?? message.created_at);
  const startedAt = parseMessageDate(userMessage?.created_at ?? message.created_at);
  return {
    durationLabel:
      completedAt && startedAt
        ? formatWorkedDuration(completedAt.getTime() - startedAt.getTime())
        : null,
    timeLabel: completedAt ? formatMessageClock(completedAt) : null,
    completedAtIso: completedAt?.toISOString() ?? null,
  };
}

function findTurnUserMessage(
  messages: MessageRecord[],
  messageIndex: number,
  turnId?: string,
): MessageRecord | undefined {
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!candidate || candidate.role !== "user") continue;
    if (!turnId || candidate.turn_id === turnId) return candidate;
  }
  return undefined;
}

function parseMessageDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatWorkedDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatMessageClock(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
