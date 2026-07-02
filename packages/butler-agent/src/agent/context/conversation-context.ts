import { homedir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from "../conversation/store.ts";
import { conversationSessionIdForDurableSession } from "../conversation/session-admission.ts";
import type {
  ConversationMessageWithParts,
  ConversationContextStoreReader,
} from "../conversation/types.ts";
import {
  textForMessage,
  toContextMessage,
  toContextSummary,
  renderPromptMaterial,
  type ConversationContextMessage,
  type ConversationContextPart,
  type ConversationContextSummary,
  type PromptMaterialRenderOptions,
} from "./conversation-context-format.ts";

export {
  renderPromptMaterial,
  type ConversationContextMessage,
  type ConversationContextPart,
  type ConversationContextSummary,
  type PromptMaterialRenderOptions,
};

export type ConversationContextDirection = "before" | "after" | "around";

export interface ReadConversationContextInput {
  sessionId: string;
  butlerData?: string;
  reader?: ConversationContextReader;
  gateway?: string;
  query?: string;
  anchorMessageId?: string;
  anchorEventId?: string;
  direction?: ConversationContextDirection;
  limit?: number;
  maxChars?: number;
  includeTools?: boolean;
}

export interface ConversationContextResult {
  ok: true;
  session_id: string;
  runtime_session_id: string;
  query: string | null;
  anchor_message_id: string | null;
  anchor_event_id: string | null;
  direction: ConversationContextDirection;
  returned: number;
  truncated: boolean;
  messages: ConversationContextMessage[];
  summaries: ConversationContextSummary[];
}

export type ConversationContextReader = ConversationContextStoreReader;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 80;
const DEFAULT_MAX_CHARS = 4000;
const MAX_CHARS = 12000;

function defaultButlerData(explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function canonicalConversationSessionId(input: {
  reader: ConversationContextReader;
  runtimeSessionId: string;
  gateway?: string | null;
}): string {
  const runtimeSessionId = input.runtimeSessionId.trim();
  if (!runtimeSessionId) return conversationSessionIdForDurableSession("butler/main");
  if (input.reader.getSession(runtimeSessionId)) return runtimeSessionId;
  const gateway = input.gateway?.trim();
  if (gateway) {
    const bound = input.reader.getSessionByGatewayBinding(gateway, runtimeSessionId);
    if (bound) return bound.id;
  }
  return conversationSessionIdForDurableSession(runtimeSessionId);
}

export function withConversationReader<T>(input: {
  butlerData?: string;
  reader?: ConversationContextReader;
  fn: (reader: ConversationContextReader) => T;
}): T {
  if (input.reader) return input.fn(input.reader);
  const store = new AgentConversationStore({ butlerData: defaultButlerData(input.butlerData) });
  try {
    return input.fn(store);
  } finally {
    store.close();
  }
}

export function readConversationContext(input: ReadConversationContextInput): ConversationContextResult {
  return withConversationReader({
    butlerData: input.butlerData,
    reader: input.reader,
    fn: (reader) => readConversationContextWithReader(reader, input),
  });
}

function readConversationContextWithReader(
  reader: ConversationContextReader,
  input: ReadConversationContextInput,
): ConversationContextResult {
  const limit = clampInteger(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxChars = clampInteger(input.maxChars, DEFAULT_MAX_CHARS, 200, MAX_CHARS);
  const direction = input.direction ?? "around";
  const query = input.query?.trim() || "";
  const canonicalSessionId = canonicalConversationSessionId({
    reader,
    runtimeSessionId: input.sessionId,
    gateway: input.gateway,
  });
  const anchorMessage = resolveAnchorMessage(reader, canonicalSessionId, input);
  const messages = selectMessages({
    reader,
    sessionId: canonicalSessionId,
    anchorMessageId: anchorMessage?.id ?? null,
    query,
    direction,
    limit,
  });
  const summaries = reader.readSummaries(canonicalSessionId)
    .filter((summary) => summary.covers_to_seq < (messages[0]?.seq ?? Number.POSITIVE_INFINITY));
  const rendered = messages.map((message) => toContextMessage(message, input.includeTools === true));
  const budgeted = applyCharBudget(rendered, maxChars);
  const requestedAnchorMessageId = input.anchorMessageId?.trim() || null;
  return {
    ok: true,
    session_id: canonicalSessionId,
    runtime_session_id: input.sessionId,
    query: query || null,
    anchor_message_id: anchorMessage?.id ?? requestedAnchorMessageId,
    anchor_event_id: input.anchorEventId?.trim() || null,
    direction,
    returned: budgeted.messages.length,
    truncated: budgeted.truncated || rendered.length > budgeted.messages.length,
    messages: budgeted.messages,
    summaries: summaries.map(toContextSummary),
  };
}

function resolveAnchorMessage(
  reader: ConversationContextReader,
  sessionId: string,
  input: ReadConversationContextInput,
): ConversationMessageWithParts | null {
  const anchorMessageId = input.anchorMessageId?.trim();
  if (anchorMessageId) {
    const message = reader.readMessageById(anchorMessageId);
    if (message?.session_id === sessionId) return message;
  }
  const anchorEventId = input.anchorEventId?.trim();
  if (anchorEventId) return reader.readMessageBySourceRef(sessionId, anchorEventId);
  return null;
}

function selectMessages(input: {
  reader: ConversationContextReader;
  sessionId: string;
  anchorMessageId: string | null;
  query: string;
  direction: ConversationContextDirection;
  limit: number;
}): ConversationMessageWithParts[] {
  if (input.anchorMessageId) {
    return input.reader.readMessagesAround({
      sessionId: input.sessionId,
      anchorMessageId: input.anchorMessageId,
      direction: input.direction,
      limit: input.limit,
    });
  }
  if (!input.query) {
    return input.reader.readMessagesAround({
      sessionId: input.sessionId,
      direction: "before",
      limit: input.limit,
    });
  }
  const all = input.reader.readMessages({
    sessionId: input.sessionId,
    includeCompacted: false,
    limit: 5000,
  });
  const matches = matchingIndices(all, input.query);
  const selected = new Map<string, ConversationMessageWithParts>();
  for (const index of matches) {
    for (const selectedIndex of indicesAround(index, all.length, input.direction, input.limit)) {
      const message = all[selectedIndex];
      if (message) selected.set(message.id, message);
      if (selected.size >= input.limit) break;
    }
    if (selected.size >= input.limit) break;
  }
  if (selected.size === 0) {
    return input.reader.readMessagesAround({
      sessionId: input.sessionId,
      direction: "before",
      limit: input.limit,
    });
  }
  return [...selected.values()].sort((a, b) => a.seq - b.seq);
}

function normalizeForSearch(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase("ko-KR");
}

function queryTerms(query: string): string[] {
  const normalized = normalizeForSearch(query).trim();
  if (!normalized) return [];
  const terms = normalized
    .split(/[\s,./!?()[\]{}'"`~:;|<>]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  return [...new Set([normalized, ...terms])];
}

function matchingIndices(messages: ConversationMessageWithParts[], query: string): number[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const matches: number[] = [];
  for (const [index, message] of messages.entries()) {
    const haystack = normalizeForSearch(textForMessage(message, false));
    if (terms.some((term) => haystack.includes(term))) matches.push(index);
  }
  return matches;
}

function indicesAround(anchor: number, length: number, direction: ConversationContextDirection, limit: number): number[] {
  if (length <= 0) return [];
  if (direction === "before") {
    const start = Math.max(0, anchor - limit + 1);
    return Array.from({ length: anchor - start + 1 }, (_, offset) => start + offset);
  }
  if (direction === "after") {
    const end = Math.min(length - 1, anchor + limit - 1);
    return Array.from({ length: end - anchor + 1 }, (_, offset) => anchor + offset);
  }
  const before = Math.floor((limit - 1) / 2);
  const start = Math.max(0, anchor - before);
  const end = Math.min(length - 1, start + limit - 1);
  const adjustedStart = Math.max(0, end - limit + 1);
  return Array.from({ length: end - adjustedStart + 1 }, (_, offset) => adjustedStart + offset);
}

function applyCharBudget(messages: ConversationContextMessage[], maxChars: number): {
  messages: ConversationContextMessage[];
  truncated: boolean;
} {
  const selected: ConversationContextMessage[] = [];
  let used = 0;
  for (const message of messages) {
    const cost = message.text.length + message.created_at.length + message.conversation_message_id.length + 32;
    if (selected.length > 0 && used + cost > maxChars) {
      return { messages: selected, truncated: true };
    }
    if (cost > maxChars) {
      selected.push({
        ...message,
        text: `${message.text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}...`,
      });
      return { messages: selected, truncated: true };
    }
    selected.push(message);
    used += cost;
  }
  return { messages: selected, truncated: false };
}
