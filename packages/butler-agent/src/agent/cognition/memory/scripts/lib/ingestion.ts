import { existsSync, readFileSync } from "fs";
import {
  buildIndexInputFromMessages,
  chunkConversationByGap,
  parseConversationLogLines,
  renderConversationText,
  type ConversationChunk,
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
}

export interface MemoryTranscriptPayload {
  sourceSessionId: string;
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
