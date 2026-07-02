import { existsSync, readFileSync } from "fs";
import {
  buildIndexInputFromObservations,
  buildIndexInputFromMessages,
  chunkConversationByGap,
  parseConversationLogLines,
  readConversationObservations,
  renderConversationText,
  type ConversationChunk,
  type ConversationObservation,
  type ConversationMessage,
} from "./conversation-sources.ts";
import { memoryChunkSessionId, memorySessionId, type MemorySessionId } from "./session-id.ts";

export interface MemoryConversationChunk {
  sessionId: MemorySessionId;
  messages: ConversationMessage[];
  conversationText: string;
  indexJsonl: string;
  startTime: string;
  endTime: string;
  sourceMessageIds: string[];
}

export interface MemoryTranscriptPayload {
  sourceSessionId: string;
  chunks: MemoryConversationChunk[];
  messageCount: number;
}

export interface MemoryConversationObservationPayload {
  sourceSessionId: string;
  conversationSessionId: string | null;
  chunks: MemoryConversationChunk[];
  messageCount: number;
}

function toMemoryChunk(sessionId: MemorySessionId, chunk: ConversationChunk): MemoryConversationChunk {
  return {
    sessionId,
    messages: chunk.messages,
    conversationText: renderConversationText(chunk.messages),
    indexJsonl: buildIndexInputFromMessages(chunk.messages),
    startTime: chunk.startTime,
    endTime: chunk.endTime,
    sourceMessageIds: [],
  };
}

function toObservationMemoryChunk(
  sessionId: MemorySessionId,
  observations: ConversationObservation[],
): MemoryConversationChunk {
  return {
    sessionId,
    messages: observations.map((observation) => ({
      role: observation.role === "assistant" ? "assistant" : "human",
      text: observation.text,
      timestamp: observation.created_at,
    })),
    conversationText: renderObservationText(observations),
    indexJsonl: buildIndexInputFromObservations(observations),
    startTime: observations[0]?.created_at ?? "",
    endTime: observations.at(-1)?.created_at ?? "",
    sourceMessageIds: observations.map((observation) => observation.conversation_message_id),
  };
}

export function buildMemoryTranscriptPayload(input: {
  lines: string[];
  sourceSessionId: string;
  chunkByGap?: boolean;
}): MemoryTranscriptPayload {
  const parsed = parseConversationLogLines(input.lines);
  const sourceSessionId = parsed.sessionId ?? input.sourceSessionId;
  const messages = parsed.messages;
  if (messages.length === 0) {
    return {
      sourceSessionId,
      chunks: [],
      messageCount: 0,
    };
  }

  if (!input.chunkByGap) {
    const first = messages[0];
    const last = messages[messages.length - 1];
    return {
      sourceSessionId,
      chunks: [
        toMemoryChunk(memorySessionId(sourceSessionId), {
          messages,
          startTime: first.timestamp,
          endTime: last.timestamp,
        }),
      ],
      messageCount: messages.length,
    };
  }

  return {
    sourceSessionId,
    chunks: chunkConversationByGap(messages).map((chunk, index) => (
      toMemoryChunk(memoryChunkSessionId(sourceSessionId, index), chunk)
    )),
    messageCount: messages.length,
  };
}

export function readMemoryTranscriptPayload(input: {
  path: string;
  sourceSessionId: string;
  chunkByGap?: boolean;
}): MemoryTranscriptPayload {
  if (!existsSync(input.path)) {
    return {
      sourceSessionId: input.sourceSessionId,
      chunks: [],
      messageCount: 0,
    };
  }
  const lines = readFileSync(input.path, "utf8")
    .split("\n")
    .filter((line) => line.trim());
  return buildMemoryTranscriptPayload({
    lines,
    sourceSessionId: input.sourceSessionId,
    chunkByGap: input.chunkByGap,
  });
}

export function buildMemoryConversationObservationPayload(input: {
  butlerData: string;
  sourceSessionId: string;
  chunkByGap?: boolean;
  maxMessages?: number;
}): MemoryConversationObservationPayload {
  const observations = readConversationObservations({
    butlerData: input.butlerData,
    sessionId: input.sourceSessionId,
    roles: ["user", "assistant"],
    includeCompacted: true,
    maxMessages: input.maxMessages,
  });
  if (observations.length === 0) {
    return {
      sourceSessionId: input.sourceSessionId,
      conversationSessionId: null,
      chunks: [],
      messageCount: 0,
    };
  }
  const conversationSessionId = observations[0]?.conversation_session_id ?? null;
  const groups = input.chunkByGap
    ? chunkObservationsByGap(observations)
    : [observations];
  return {
    sourceSessionId: input.sourceSessionId,
    conversationSessionId,
    chunks: groups.map((chunk, index) =>
      toObservationMemoryChunk(
        input.chunkByGap
          ? memoryChunkSessionId(conversationSessionId ?? input.sourceSessionId, index)
          : memorySessionId(conversationSessionId ?? input.sourceSessionId),
        chunk,
      ),
    ),
    messageCount: observations.length,
  };
}

function renderObservationText(observations: ConversationObservation[]): string {
  return observations
    .map((observation) => {
      const role = observation.role === "assistant" ? "butler" : "user";
      return `${role}: ${observation.text}`;
    })
    .join("\n\n");
}

function chunkObservationsByGap(
  observations: ConversationObservation[],
  gapMs = 30 * 60 * 1000,
): ConversationObservation[][] {
  if (observations.length === 0) return [];
  const chunks: ConversationObservation[][] = [];
  let current = [observations[0]];
  for (let index = 1; index < observations.length; index += 1) {
    const prevTs = new Date(observations[index - 1].created_at).getTime();
    const currTs = new Date(observations[index].created_at).getTime();
    if (currTs - prevTs > gapMs) {
      chunks.push(current);
      current = [observations[index]];
      continue;
    }
    current.push(observations[index]);
  }
  chunks.push(current);
  return chunks;
}
