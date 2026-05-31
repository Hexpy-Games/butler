import { readTranscript, type TranscriptEvent } from "../../test-support/harness/transcripts.ts";

export type ConversationContextDirection = "before" | "after" | "around";

export interface ReadConversationContextInput {
  sessionId: string;
  query?: string;
  anchorEventId?: string;
  direction?: ConversationContextDirection;
  limit?: number;
  maxChars?: number;
}

export interface ConversationContextLine {
  event_id: string;
  timestamp: string;
  kind: "inbound" | "outbound";
  speaker: "user" | "butler";
  text: string;
}

export interface ConversationContextResult {
  ok: true;
  session_id: string;
  query: string | null;
  anchor_event_id: string | null;
  direction: ConversationContextDirection;
  returned: number;
  truncated: boolean;
  events: ConversationContextLine[];
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 40;
const DEFAULT_MAX_CHARS = 4000;
const MAX_CHARS = 12000;

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function eventText(event: TranscriptEvent): string | null {
  const payload = event.payload as Record<string, any>;
  const text = payload.message?.text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

function conversationLine(event: TranscriptEvent): ConversationContextLine | null {
  if (event.kind !== "inbound" && event.kind !== "outbound") return null;
  const text = eventText(event);
  if (!text) return null;
  return {
    event_id: event.eventId,
    timestamp: event.timestamp,
    kind: event.kind,
    speaker: event.kind === "inbound" ? "user" : "butler",
    text,
  };
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

function matchingIndices(lines: ConversationContextLine[], query: string): number[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const matches: number[] = [];
  for (const [index, line] of lines.entries()) {
    const haystack = normalizeForSearch(line.text);
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

function applyCharBudget(lines: ConversationContextLine[], maxChars: number): {
  lines: ConversationContextLine[];
  truncated: boolean;
} {
  const selected: ConversationContextLine[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.text.length + line.timestamp.length + line.event_id.length + 16;
    if (selected.length > 0 && used + cost > maxChars) {
      return { lines: selected, truncated: true };
    }
    if (cost > maxChars) {
      selected.push({
        ...line,
        text: `${line.text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}...`,
      });
      return { lines: selected, truncated: true };
    }
    selected.push(line);
    used += cost;
  }
  return { lines: selected, truncated: false };
}

export function readConversationContext(input: ReadConversationContextInput): ConversationContextResult {
  const limit = clampInteger(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxChars = clampInteger(input.maxChars, DEFAULT_MAX_CHARS, 200, MAX_CHARS);
  const direction = input.direction ?? "around";
  const query = input.query?.trim() || "";
  const anchorEventId = input.anchorEventId?.trim() || "";
  const lines = readTranscript(input.sessionId)
    .map(conversationLine)
    .filter((line): line is ConversationContextLine => Boolean(line));

  let indices: number[] = [];
  if (anchorEventId) {
    const anchor = lines.findIndex((line) => line.event_id === anchorEventId);
    if (anchor >= 0) indices.push(...indicesAround(anchor, lines.length, direction, limit));
  }
  if (query) {
    for (const match of matchingIndices(lines, query)) {
      indices.push(...indicesAround(match, lines.length, direction, limit));
    }
  }
  if (indices.length === 0) {
    const start = Math.max(0, lines.length - limit);
    indices = Array.from({ length: lines.length - start }, (_, offset) => start + offset);
  }

  const unique = [...new Set(indices)]
    .filter((index) => index >= 0 && index < lines.length)
    .sort((a, b) => a - b)
    .slice(0, limit);
  const budgeted = applyCharBudget(unique.map((index) => lines[index]!), maxChars);

  return {
    ok: true,
    session_id: input.sessionId,
    query: query || null,
    anchor_event_id: anchorEventId || null,
    direction,
    returned: budgeted.lines.length,
    truncated: budgeted.truncated || unique.length > budgeted.lines.length,
    events: budgeted.lines,
  };
}
