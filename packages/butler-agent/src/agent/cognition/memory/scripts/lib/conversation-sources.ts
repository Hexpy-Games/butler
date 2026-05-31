import type { TranscriptEvent } from "../../../../../test-support/harness/transcripts.ts";

export type ConversationRole = "human" | "assistant" | "channel";

export interface ConversationMessage {
  role: ConversationRole;
  text: string;
  timestamp: string;
}

export interface ConversationChunk {
  messages: ConversationMessage[];
  startTime: string;
  endTime: string;
}

export type ConversationLogFormat = "butler-transcript" | "unknown";

export interface ParsedConversationLog {
  format: ConversationLogFormat;
  sessionId?: string;
  messages: ConversationMessage[];
}

const THIRTY_MIN_MS = 30 * 60 * 1000;

function parseJsonLine(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isButlerTranscriptEvent(value: any): value is TranscriptEvent {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.eventId === "string" &&
      typeof value.sessionId === "string" &&
      typeof value.kind === "string" &&
      typeof value.timestamp === "string" &&
      value.payload &&
      typeof value.payload === "object",
  );
}

function appendMessage(
  messages: ConversationMessage[],
  role: ConversationRole,
  text: string,
  timestamp: string,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role && last.text === trimmed) {
    return;
  }
  messages.push({
    role,
    text: trimmed,
    timestamp,
  });
}

function nestedText(payload: Record<string, unknown>, key: "message" | "text"): string {
  if (key === "text") {
    return typeof payload.text === "string" ? payload.text : "";
  }
  const message = payload.message;
  if (!message || typeof message !== "object") return "";
  const text = (message as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

export function detectConversationLogFormat(lines: string[]): ConversationLogFormat {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseJsonLine(trimmed);
    if (!parsed) continue;
    if (isButlerTranscriptEvent(parsed)) return "butler-transcript";
  }
  return "unknown";
}

export function parseButlerTranscriptLines(lines: string[]): ParsedConversationLog {
  const messages: ConversationMessage[] = [];
  let sessionId: string | undefined;

  for (const line of lines) {
    const obj = parseJsonLine(line);
    if (!isButlerTranscriptEvent(obj)) continue;
    sessionId ??= obj.sessionId;

    if (obj.kind === "inbound") {
      const text = nestedText(obj.payload, "message");
      appendMessage(messages, "human", text, obj.timestamp);
      continue;
    }

    if (obj.kind === "outbound") {
      const text = nestedText(obj.payload, "message");
      appendMessage(messages, "assistant", text, obj.timestamp);
      continue;
    }

    if (obj.kind === "turn") {
      const text = nestedText(obj.payload, "text");
      appendMessage(messages, "assistant", text, obj.timestamp);
    }
  }

  return {
    format: "butler-transcript",
    sessionId,
    messages,
  };
}

export function parseConversationLogLines(lines: string[]): ParsedConversationLog {
  const format = detectConversationLogFormat(lines);
  if (format === "butler-transcript") {
    return parseButlerTranscriptLines(lines);
  }
  return {
    format: "unknown",
    messages: [],
  };
}

export function renderConversationText(messages: ConversationMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "butler" : "user";
      return `${role}: ${message.text}`;
    })
    .join("\n\n");
}

export function buildIndexInputFromMessages(messages: ConversationMessage[]): string {
  return messages
    .map((message) => JSON.stringify(
      message.role === "assistant"
        ? {
            type: "assistant",
            timestamp: message.timestamp,
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: message.text,
                },
              ],
            },
          }
        : {
            type: "user",
            timestamp: message.timestamp,
            message: {
              role: "user",
              content: message.text,
            },
          },
    ))
    .join("\n");
}

export function chunkConversationByGap(
  messages: ConversationMessage[],
  gapMs = THIRTY_MIN_MS,
): ConversationChunk[] {
  if (messages.length === 0) return [];

  const chunks: ConversationChunk[] = [];
  let current = [messages[0]];

  for (let index = 1; index < messages.length; index += 1) {
    const prevTs = new Date(messages[index - 1].timestamp).getTime();
    const currTs = new Date(messages[index].timestamp).getTime();
    if (currTs - prevTs > gapMs) {
      chunks.push({
        messages: current,
        startTime: current[0].timestamp,
        endTime: current[current.length - 1].timestamp,
      });
      current = [messages[index]];
      continue;
    }
    current.push(messages[index]);
  }

  chunks.push({
    messages: current,
    startTime: current[0].timestamp,
    endTime: current[current.length - 1].timestamp,
  });
  return chunks;
}
