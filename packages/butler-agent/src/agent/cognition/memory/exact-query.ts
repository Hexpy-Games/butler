import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import {
  readConversationObservations,
  type ConversationObservationRole,
} from "./scripts/lib/conversation-sources.ts";
import { conversationStorePath } from "../../conversation/store.ts";

export type MemoryQueryScope = "all_sessions" | "session";
export type MemoryQuerySpeaker = "any" | "user" | "butler";
export type MemoryQueryEventKind = "any" | "inbound" | "outbound";
export type MemoryQueryOrder = "earliest" | "latest";
export type MemoryQueryMatchMode = "any" | "all" | "phrase";
export type ExactQuerySource = "conversation-store" | "app-projection-compat" | "transcript-recovery-index";

export interface QueryMemoryInput {
  butlerData: string;
  appMessageDbPath?: string;
  query?: string;
  scope?: MemoryQueryScope;
  sessionId?: string;
  speaker?: MemoryQuerySpeaker;
  eventKind?: MemoryQueryEventKind;
  order?: MemoryQueryOrder;
  matchMode?: MemoryQueryMatchMode;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  includeInternal?: boolean;
  includePlaceholders?: boolean;
  includeTranscriptRecovery?: boolean;
}

export interface QueryMemoryMatch {
  event_id: string;
  session_id: string;
  timestamp: string;
  timestamp_local: string | null;
  timezone: string | null;
  speaker: Exclude<MemoryQuerySpeaker, "any">;
  kind: Exclude<MemoryQueryEventKind, "any">;
  text: string;
  source: ExactQuerySource;
  conversation_message_id: string | null;
  transcript_file: string | null;
  matched_terms: string[];
}

export interface QueryMemoryResult {
  query: string | null;
  scope: MemoryQueryScope;
  session_id: string | null;
  speaker: MemoryQuerySpeaker;
  event_kind: MemoryQueryEventKind;
  order: MemoryQueryOrder;
  match_mode: MemoryQueryMatchMode;
  limit: number;
  total_matches: number;
  returned: number;
  inspected_sources: string[];
  skipped_sources: string[];
  results: QueryMemoryMatch[];
  diagnostics: string[];
}

export interface TranscriptQueryIndexMessage {
  sourceId: string;
  sourceEventId: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  transcriptFile: string | null;
  internal: boolean;
  placeholder: boolean;
}

interface IndexedRow {
  event_id: string;
  session_id: string;
  role: "user" | "assistant";
  text: string;
  created_at: string;
  source: QueryMemoryMatch["source"];
  conversation_message_id: string | null;
  transcript_file: string | null;
}

interface SourceQueryResult {
  source: string;
  skipped?: string;
  total: number;
  rows: IndexedRow[];
  diagnostics: string[];
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_TEXT_CHARS = 900;
const APP_MESSAGE_DB_RELATIVE = ["app-server", "butler-client.sqlite"];
const TRANSCRIPT_QUERY_DB_RELATIVE = ["cognition", "memory", "query", "messages.sqlite"];

export function appMessageDbPath(butlerData: string): string {
  return join(butlerData, ...APP_MESSAGE_DB_RELATIVE);
}

export function transcriptQueryDbPath(butlerData: string): string {
  return join(butlerData, ...TRANSCRIPT_QUERY_DB_RELATIVE);
}

export function ensureAppMessageQuerySchema(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS messages_role_created_idx
    ON messages(role, created_at, id);

    CREATE INDEX IF NOT EXISTS messages_chat_role_created_idx
    ON messages(chat_id, role, created_at, id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(text, tokenize = 'unicode61');

    INSERT INTO messages_fts(rowid, text)
    SELECT m.rowid, m.text
    FROM messages m
    WHERE NOT EXISTS (
      SELECT 1 FROM messages_fts f WHERE f.rowid = m.rowid
    );

    CREATE TRIGGER IF NOT EXISTS messages_fts_ai
    AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_ad
    AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_au
    AFTER UPDATE OF text ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
}

export function ensureTranscriptQueryIndexSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      source_id TEXT PRIMARY KEY,
      source_event_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      transcript_file TEXT,
      internal INTEGER NOT NULL DEFAULT 0,
      placeholder INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS conversation_messages_role_created_idx
    ON conversation_messages(role, created_at, source_id);

    CREATE INDEX IF NOT EXISTS conversation_messages_session_role_created_idx
    ON conversation_messages(session_id, role, created_at, source_id);

    CREATE INDEX IF NOT EXISTS conversation_messages_created_idx
    ON conversation_messages(created_at, source_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts
    USING fts5(text, tokenize = 'unicode61');
  `);
}

export function upsertTranscriptQueryIndexMessages(
  butlerData: string,
  messages: TranscriptQueryIndexMessage[],
): { indexed: number } {
  if (messages.length === 0) return { indexed: 0 };
  const dbPath = transcriptQueryDbPath(butlerData);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  try {
    ensureTranscriptQueryIndexSchema(db);
    const upsert = db.query(`
      INSERT INTO conversation_messages (
        source_id, source_event_id, session_id, role, text, created_at,
        transcript_file, internal, placeholder, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        source_event_id = excluded.source_event_id,
        session_id = excluded.session_id,
        role = excluded.role,
        text = excluded.text,
        created_at = excluded.created_at,
        transcript_file = excluded.transcript_file,
        internal = excluded.internal,
        placeholder = excluded.placeholder,
        updated_at = excluded.updated_at
    `);
    const rowidQuery = db.query<{ rowid: number }, [string]>(
      "SELECT rowid FROM conversation_messages WHERE source_id = ?",
    );
    const deleteFts = db.query("DELETE FROM conversation_messages_fts WHERE rowid = ?");
    const insertFts = db.query("INSERT INTO conversation_messages_fts(rowid, text) VALUES (?, ?)");
    const now = new Date().toISOString();
    const tx = db.transaction((items: TranscriptQueryIndexMessage[]) => {
      for (const message of items) {
        upsert.run(
          message.sourceId,
          message.sourceEventId,
          message.sessionId,
          message.role,
          message.text,
          message.createdAt,
          message.transcriptFile,
          message.internal ? 1 : 0,
          message.placeholder ? 1 : 0,
          now,
        );
        const row = rowidQuery.get(message.sourceId);
        if (!row) continue;
        deleteFts.run(row.rowid);
        insertFts.run(row.rowid, message.text);
      }
    });
    tx(messages);
    return { indexed: messages.length };
  } finally {
    db.close();
  }
}

export function transcriptQueryIndexMessagesFromLines(input: {
  lines: string[];
  transcriptFile?: string | null;
}): TranscriptQueryIndexMessage[] {
  const messages: TranscriptQueryIndexMessage[] = [];
  for (const line of input.lines) {
    const event = parseTranscriptEventLine(line);
    if (!event) continue;
    const text = eventText(event.payload);
    if (!text) continue;
    const role = event.kind === "inbound" ? "user" : "assistant";
    const timestampMs = Date.parse(event.timestamp);
    if (!Number.isFinite(timestampMs)) continue;
    messages.push({
      sourceId: `transcript:${event.eventId}`,
      sourceEventId: event.eventId,
      sessionId: event.sessionId,
      role,
      text,
      createdAt: new Date(timestampMs).toISOString(),
      transcriptFile: input.transcriptFile ?? null,
      internal: isInternalTranscriptEvent(event),
      placeholder: isPlaceholderTranscriptEvent(event, timestampMs),
    });
  }
  return messages;
}

export function indexTranscriptLinesForQuery(input: {
  butlerData: string;
  lines: string[];
  transcriptFile?: string | null;
}): { indexed: number } {
  return upsertTranscriptQueryIndexMessages(
    input.butlerData,
    transcriptQueryIndexMessagesFromLines({
      lines: input.lines,
      transcriptFile: input.transcriptFile,
    }),
  );
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function canonicalScope(value: unknown): MemoryQueryScope {
  return value === "session" ? "session" : "all_sessions";
}

function canonicalSpeaker(value: unknown): MemoryQuerySpeaker {
  return value === "user" || value === "butler" ? value : "any";
}

function canonicalEventKind(value: unknown): MemoryQueryEventKind {
  return value === "inbound" || value === "outbound" ? value : "any";
}

function canonicalOrder(value: unknown): MemoryQueryOrder {
  return value === "latest" ? "latest" : "earliest";
}

function canonicalMatchMode(value: unknown): MemoryQueryMatchMode {
  if (value === "all" || value === "phrase") return value;
  return "any";
}

function parseDateLowerBoundary(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseDateUpperExclusiveBoundary(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(trimmed);
  return new Date(parsed + (dateOnly ? 24 * 60 * 60 * 1000 : 1)).toISOString();
}

function compactText(text: string): string {
  const compacted = text.replace(/\s+/gu, " ").trim();
  if (compacted.length <= MAX_TEXT_CHARS) return compacted;
  return `${compacted.slice(0, MAX_TEXT_CHARS - 3).trimEnd()}...`;
}

function localTimestamp(timestamp: string): { value: string | null; timezone: string | null } {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return { value: null, timezone: null };
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    return {
      value: new Intl.DateTimeFormat("sv-SE", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(date),
      timezone,
    };
  } catch {
    return { value: date.toISOString(), timezone: "UTC" };
  }
}

function normalizeForSearch(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase("ko-KR");
}

function searchTerms(query: string): string[] {
  const normalized = normalizeForSearch(query).trim();
  if (!normalized) return [];
  const terms = normalized
    .split(/[\s,./!?()[\]{}'"`~:;|<>]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  return [...new Set(terms.length > 0 ? terms : [normalized])];
}

function ftsQuery(query: string, mode: MemoryQueryMatchMode): string | null {
  const phrase = query.trim().replace(/"/gu, '""');
  if (!phrase) return null;
  if (mode === "phrase") return `"${phrase}"`;
  const terms = searchTerms(query).map((term) => `"${term.replace(/"/gu, '""')}"`);
  if (terms.length === 0) return null;
  return terms.join(mode === "all" ? " AND " : " OR ");
}

function matchedTerms(text: string, query: string, mode: MemoryQueryMatchMode): string[] {
  const normalizedText = normalizeForSearch(text);
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  if (mode === "phrase") {
    const normalized = normalizeForSearch(query).trim();
    return normalized && normalizedText.includes(normalized) ? [normalized] : [];
  }
  const matched = terms.filter((term) => normalizedText.includes(term));
  return mode === "all" && matched.length !== terms.length ? [] : matched;
}

function roleFilter(speaker: MemoryQuerySpeaker, eventKind: MemoryQueryEventKind): string[] {
  if (speaker === "user" || eventKind === "inbound") return ["user"];
  if (speaker === "butler" || eventKind === "outbound") return ["assistant"];
  return ["user", "assistant"];
}

function observationRoleFilter(
  speaker: MemoryQuerySpeaker,
  eventKind: MemoryQueryEventKind,
): ConversationObservationRole[] {
  return roleFilter(speaker, eventKind) as ConversationObservationRole[];
}

function appSessionId(chatId: string): string {
  return chatId === "general" ? "butler/app-general" : `butler/app-${safeSessionSegment(chatId)}`;
}

function isAppSessionId(sessionId: string): boolean {
  return sessionId.startsWith("butler/app-");
}

function chatIdFromSessionId(sessionId: string): string {
  if (sessionId === "butler/app-general") return "general";
  if (sessionId.startsWith("butler/app-")) return sessionId.slice("butler/app-".length);
  return sessionId;
}

function safeSessionSegment(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9._-]+/gu, "-");
  return normalized || "session";
}

function hasTable(db: Database, table: string): boolean {
  const row = db.query<{ name: string }, [string]>(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?",
  ).get(table);
  return Boolean(row);
}

function hasIndex(db: Database, table: string, index: string): boolean {
  return db.query<{ name: string }, []>(`PRAGMA index_list(${table})`)
    .all()
    .some((row) => row.name === index);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, (_, index) => `$role${index}`).join(", ");
}

function queryAppMessages(input: {
  dbPath: string;
  query: string;
  scope: MemoryQueryScope;
  sessionId: string;
  speaker: MemoryQuerySpeaker;
  eventKind: MemoryQueryEventKind;
  order: MemoryQueryOrder;
  matchMode: MemoryQueryMatchMode;
  limit: number;
  dateFrom: string | null;
  dateTo: string | null;
}): SourceQueryResult {
  if (!existsSync(input.dbPath)) {
    return { source: "app-projection-compat", skipped: "app message db missing", total: 0, rows: [], diagnostics: [] };
  }
  const db = new Database(input.dbPath, { readonly: true });
  try {
    if (!hasTable(db, "messages")) {
      return { source: "app-projection-compat", skipped: "messages table missing", total: 0, rows: [], diagnostics: [] };
    }
    const needsSessionIndex = input.scope === "session";
    const requiredIndex = needsSessionIndex ? "messages_chat_role_created_idx" : "messages_role_created_idx";
    if (!hasIndex(db, "messages", requiredIndex)) {
      return {
        source: "app-projection-compat",
        skipped: `${requiredIndex} missing; refusing full message scan`,
        total: 0,
        rows: [],
        diagnostics: [],
      };
    }
    const fts = input.query ? ftsQuery(input.query, input.matchMode) : null;
    if (input.query && (!fts || !hasTable(db, "messages_fts"))) {
      return { source: "app-projection-compat", skipped: "messages_fts missing; refusing LIKE scan", total: 0, rows: [], diagnostics: [] };
    }
    const roles = roleFilter(input.speaker, input.eventKind);
    const params: Record<string, string | number> = {
      $limit: input.limit,
    };
    const clauses = [`m.role IN (${placeholders(roles.length)})`];
    roles.forEach((role, index) => {
      params[`$role${index}`] = role;
    });
    if (input.scope === "session" && input.sessionId) {
      clauses.push("m.chat_id = $chat_id");
      params.$chat_id = chatIdFromSessionId(input.sessionId);
    }
    if (input.dateFrom) {
      clauses.push("m.created_at >= $date_from");
      params.$date_from = input.dateFrom;
    }
    if (input.dateTo) {
      clauses.push("m.created_at < $date_to");
      params.$date_to = input.dateTo;
    }
    if (fts) {
      clauses.push("m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH $fts)");
      params.$fts = fts;
    }
    const where = clauses.join(" AND ");
    const order = input.order === "latest" ? "DESC" : "ASC";
    const count = db.query<{ count: number }, Record<string, string | number>>(
      `SELECT COUNT(*) AS count FROM messages m WHERE ${where}`,
    ).get(params)?.count ?? 0;
    const rows = db.query<{
      event_id: string;
      chat_id: string;
      role: "user" | "assistant";
      text: string;
      created_at: string;
    }, Record<string, string | number>>(`
      SELECT m.id AS event_id, m.chat_id, m.role, m.text, m.created_at
      FROM messages m
      WHERE ${where}
      ORDER BY m.created_at ${order}, m.id ${order}
      LIMIT $limit
    `).all(params);
    return {
      source: "app-projection-compat",
      total: Number(count),
      rows: rows.map((row) => ({
        event_id: row.event_id,
        session_id: appSessionId(row.chat_id),
        role: row.role,
        text: row.text,
        created_at: row.created_at,
        source: "app-projection-compat" as const,
        conversation_message_id: null,
        transcript_file: null,
      })),
      diagnostics: [],
    };
  } finally {
    db.close();
  }
}

function queryConversationStore(input: {
  butlerData: string;
  query: string;
  scope: MemoryQueryScope;
  sessionId: string;
  speaker: MemoryQuerySpeaker;
  eventKind: MemoryQueryEventKind;
  order: MemoryQueryOrder;
  matchMode: MemoryQueryMatchMode;
  limit: number;
  dateFrom: string | null;
  dateTo: string | null;
}): SourceQueryResult {
  if (!existsSync(conversationStorePath(input.butlerData))) {
    return { source: "conversation-store", skipped: "conversation store missing", total: 0, rows: [], diagnostics: [] };
  }
  const observations = readConversationObservations({
    butlerData: input.butlerData,
    sessionId: input.scope === "session" ? input.sessionId : undefined,
    roles: observationRoleFilter(input.speaker, input.eventKind),
    since: input.dateFrom,
    includeCompacted: true,
    order: input.order === "latest" ? "desc" : "asc",
    maxMessages: 5000,
  }).filter((observation) => {
    if (input.dateTo && observation.created_at >= input.dateTo) return false;
    if (!input.query) return true;
    return matchedTerms(observation.text, input.query, input.matchMode).length > 0;
  });
  return {
    source: "conversation-store",
    total: observations.length,
    rows: observations.slice(0, input.limit).map((observation) => ({
      event_id: observation.conversation_message_id,
      session_id: observation.conversation_session_id,
      role: observation.role === "assistant" ? "assistant" : "user",
      text: observation.text,
      created_at: observation.created_at,
      source: "conversation-store",
      conversation_message_id: observation.conversation_message_id,
      transcript_file: null,
    })),
    diagnostics: [],
  };
}

function queryTranscriptIndex(input: {
  dbPath: string;
  query: string;
  scope: MemoryQueryScope;
  sessionId: string;
  speaker: MemoryQuerySpeaker;
  eventKind: MemoryQueryEventKind;
  order: MemoryQueryOrder;
  matchMode: MemoryQueryMatchMode;
  limit: number;
  dateFrom: string | null;
  dateTo: string | null;
  includeInternal: boolean;
  includePlaceholders: boolean;
  excludeAppSessions: boolean;
}): SourceQueryResult {
  if (!existsSync(input.dbPath)) {
    return { source: "transcript-recovery-index", skipped: "transcript query index missing", total: 0, rows: [], diagnostics: [] };
  }
  const db = new Database(input.dbPath, { readonly: true });
  try {
    if (!hasTable(db, "conversation_messages")) {
      return { source: "transcript-recovery-index", skipped: "conversation_messages table missing", total: 0, rows: [], diagnostics: [] };
    }
    const needsSessionIndex = input.scope === "session";
    const requiredIndex = needsSessionIndex
      ? "conversation_messages_session_role_created_idx"
      : "conversation_messages_role_created_idx";
    if (!hasIndex(db, "conversation_messages", requiredIndex)) {
      return {
        source: "transcript-recovery-index",
        skipped: `${requiredIndex} missing; refusing full transcript index scan`,
        total: 0,
        rows: [],
        diagnostics: [],
      };
    }
    if (input.excludeAppSessions && input.scope === "session" && isAppSessionId(input.sessionId)) {
      return {
        source: "transcript-recovery-index",
        skipped: "app session covered by app message db",
        total: 0,
        rows: [],
        diagnostics: [],
      };
    }
    const fts = input.query ? ftsQuery(input.query, input.matchMode) : null;
    if (input.query && (!fts || !hasTable(db, "conversation_messages_fts"))) {
      return {
        source: "transcript-recovery-index",
        skipped: "conversation_messages_fts missing; refusing LIKE scan",
        total: 0,
        rows: [],
        diagnostics: [],
      };
    }
    const roles = roleFilter(input.speaker, input.eventKind);
    const params: Record<string, string | number> = {
      $limit: input.limit,
    };
    const clauses = [`m.role IN (${placeholders(roles.length)})`];
    roles.forEach((role, index) => {
      params[`$role${index}`] = role;
    });
    if (input.scope === "session" && input.sessionId) {
      clauses.push("m.session_id = $session_id");
      params.$session_id = input.sessionId;
    } else if (input.excludeAppSessions) {
      clauses.push("m.session_id NOT LIKE 'butler/app-%'");
    }
    if (input.dateFrom) {
      clauses.push("m.created_at >= $date_from");
      params.$date_from = input.dateFrom;
    }
    if (input.dateTo) {
      clauses.push("m.created_at < $date_to");
      params.$date_to = input.dateTo;
    }
    if (!input.includeInternal) clauses.push("m.internal = 0");
    if (!input.includePlaceholders) clauses.push("m.placeholder = 0");
    if (fts) {
      clauses.push("m.rowid IN (SELECT rowid FROM conversation_messages_fts WHERE conversation_messages_fts MATCH $fts)");
      params.$fts = fts;
    }
    const where = clauses.join(" AND ");
    const order = input.order === "latest" ? "DESC" : "ASC";
    const count = db.query<{ count: number }, Record<string, string | number>>(
      `SELECT COUNT(*) AS count FROM conversation_messages m WHERE ${where}`,
    ).get(params)?.count ?? 0;
    const rows = db.query<IndexedRow, Record<string, string | number>>(`
      SELECT
        m.source_event_id AS event_id,
        m.session_id,
        m.role,
        m.text,
        m.created_at,
        'transcript-recovery-index' AS source,
        NULL AS conversation_message_id,
        m.transcript_file
      FROM conversation_messages m
      WHERE ${where}
      ORDER BY m.created_at ${order}, m.source_id ${order}
      LIMIT $limit
    `).all(params);
    return {
      source: "transcript-recovery-index",
      total: Number(count),
      rows,
      diagnostics: [],
    };
  } finally {
    db.close();
  }
}

export function queryMemory(input: QueryMemoryInput): QueryMemoryResult {
  const query = input.query?.trim() || "";
  const scope = canonicalScope(input.scope);
  const sessionId = input.sessionId?.trim() || "";
  const speaker = canonicalSpeaker(input.speaker);
  const eventKind = canonicalEventKind(input.eventKind);
  const order = canonicalOrder(input.order);
  const matchMode = canonicalMatchMode(input.matchMode);
  const limit = clampInteger(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const dateFrom = parseDateLowerBoundary(input.dateFrom);
  const dateTo = parseDateUpperExclusiveBoundary(input.dateTo);
  const diagnostics: string[] = [];
  if (input.dateFrom && dateFrom === null) diagnostics.push("date_from was ignored because it could not be parsed");
  if (input.dateTo && dateTo === null) diagnostics.push("date_to was ignored because it could not be parsed");
  if (scope === "session" && !sessionId) {
    diagnostics.push("session scope requested without session_id");
    return {
      query: query || null,
      scope,
      session_id: null,
      speaker,
      event_kind: eventKind,
      order,
      match_mode: matchMode,
      limit,
      total_matches: 0,
      returned: 0,
      inspected_sources: [],
      skipped_sources: [
        "conversation-store: session scope missing session_id",
        "app-projection-compat: session scope missing session_id",
        "transcript-recovery-index: session scope missing session_id",
      ],
      results: [],
      diagnostics,
    };
  }

  const conversation = queryConversationStore({
    butlerData: input.butlerData,
    query,
    scope,
    sessionId,
    speaker,
    eventKind,
    order,
    matchMode,
    limit,
    dateFrom,
    dateTo,
  });
  const app = scope === "session" && conversation.total > 0
    ? {
        source: "app-projection-compat",
        skipped: "conversation store covers session",
        total: 0,
        rows: [],
        diagnostics: [],
      }
    : queryAppMessages({
        dbPath: input.appMessageDbPath ?? appMessageDbPath(input.butlerData),
        query,
        scope,
        sessionId,
        speaker,
        eventKind,
        order,
        matchMode,
        limit,
        dateFrom,
        dateTo,
      });
  const transcript = input.includeTranscriptRecovery
    ? queryTranscriptIndex({
        dbPath: transcriptQueryDbPath(input.butlerData),
        query,
        scope,
        sessionId,
        speaker,
        eventKind,
        order,
        matchMode,
        limit,
        dateFrom,
        dateTo,
        includeInternal: input.includeInternal === true,
        includePlaceholders: input.includePlaceholders === true,
        excludeAppSessions: !app.skipped,
      })
    : {
        source: "transcript-recovery-index",
        skipped: "transcript recovery source not requested",
        total: 0,
        rows: [],
        diagnostics: [],
      };

  const sourceResults = [conversation, app, transcript];
  const inspectedSources = sourceResults.filter((item) => !item.skipped).map((item) => item.source);
  const skippedSources = sourceResults.flatMap((item) => item.skipped ? [`${item.source}: ${item.skipped}`] : []);
  diagnostics.push(...sourceResults.flatMap((item) => item.diagnostics));
  diagnostics.push(...skippedSources);
  const allRows = sourceResults.flatMap((item) => item.rows);
  allRows.sort((left, right) => {
    const byTime = order === "latest"
      ? right.created_at.localeCompare(left.created_at)
      : left.created_at.localeCompare(right.created_at);
    if (byTime !== 0) return byTime;
    return order === "latest"
      ? right.event_id.localeCompare(left.event_id)
      : left.event_id.localeCompare(right.event_id);
  });

  const results = allRows.slice(0, limit).map((row) => {
    const local = localTimestamp(row.created_at);
    return {
      event_id: row.event_id,
      session_id: row.session_id,
      timestamp: row.created_at,
      timestamp_local: local.value,
      timezone: local.timezone,
      speaker: row.role === "user" ? "user" as const : "butler" as const,
      kind: row.role === "user" ? "inbound" as const : "outbound" as const,
      text: compactText(row.text),
      source: row.source,
      conversation_message_id: row.conversation_message_id,
      transcript_file: row.transcript_file,
      matched_terms: query ? matchedTerms(row.text, query, matchMode) : [],
    };
  });

  return {
    query: query || null,
    scope,
    session_id: scope === "session" ? sessionId || null : null,
    speaker,
    event_kind: eventKind,
    order,
    match_mode: matchMode,
    limit,
    total_matches: sourceResults.reduce((sum, item) => sum + item.total, 0),
    returned: results.length,
    inspected_sources: inspectedSources,
    skipped_sources: skippedSources,
    results,
    diagnostics,
  };
}

interface TranscriptEventLike {
  eventId: string;
  sessionId: string;
  kind: "inbound" | "outbound";
  timestamp: string;
  payload: Record<string, any>;
  transport?: string;
}

function parseTranscriptEventLine(line: string): TranscriptEventLike | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as TranscriptEventLike;
    if (
      typeof parsed?.eventId === "string" &&
      typeof parsed?.sessionId === "string" &&
      (parsed?.kind === "inbound" || parsed?.kind === "outbound") &&
      typeof parsed?.timestamp === "string" &&
      parsed?.payload &&
      typeof parsed.payload === "object"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function eventText(payload: Record<string, any>): string {
  const text = payload.message?.text ?? payload.text;
  return typeof text === "string" ? text.trim() : "";
}

function isInternalTranscriptEvent(event: TranscriptEventLike): boolean {
  const role = event.payload.route?.role ?? event.payload.role;
  return event.sessionId.startsWith("steward/") || role === "steward";
}

function isPlaceholderTranscriptEvent(event: TranscriptEventLike, timestampMs: number): boolean {
  const payloadEventId = event.payload.eventId;
  const messageTimestamp = event.payload.message?.timestamp;
  return timestampMs <= 0 ||
    (event.transport === "mock" && timestampMs < Date.UTC(2000, 0, 1)) ||
    (typeof payloadEventId === "string" && payloadEventId.startsWith("mock:")) ||
    (typeof messageTimestamp === "string" && Date.parse(messageTimestamp) <= 0);
}
