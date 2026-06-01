import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appMessageDbPath,
  ensureAppMessageQuerySchema,
  indexTranscriptLinesForQuery,
  queryMemory,
  transcriptQueryDbPath,
} from "../../packages/butler-agent/src/agent/cognition/memory/exact-query.ts";

let tempDir = "";
let appDb = "";

const FIRST_USER_TEXT = "SYNTHETIC_FIRST_USER_CHECKPOINT";
const SECOND_USER_TEXT = "SYNTHETIC_SECOND_USER_CHECKPOINT";

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-memory-query-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
  appDb = appMessageDbPath(tempDir);
  mkdirSync(join(tempDir, "app-server"), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createAppDb(path = appDb): Database {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      project_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureAppMessageQuerySchema(db);
  return db;
}

function insertChat(db: Database, id: string): void {
  db.query(`
    INSERT INTO chats (id, title, kind, project_id, created_at, updated_at)
    VALUES (?, ?, 'chat', NULL, '2026-04-24T00:00:00.000Z', '2026-04-24T00:00:00.000Z')
  `).run(id, id);
}

function insertMessage(db: Database, input: {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "system_event";
  text: string;
  createdAt: string;
}): void {
  db.query(`
    INSERT INTO messages (id, chat_id, role, text, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'sent', ?, ?)
  `).run(input.id, input.chatId, input.role, input.text, input.createdAt, input.createdAt);
}

function transcriptLine(input: {
  eventId: string;
  sessionId: string;
  kind: "inbound" | "outbound" | "tool_result";
  timestamp: string;
  text: string;
  transport?: string;
  routeRole?: string;
  payloadEventId?: string;
}): string {
  const payload = input.kind === "tool_result"
    ? { name: "run_command", result: input.text }
    : {
        eventId: input.payloadEventId,
        route: input.routeRole ? { role: input.routeRole } : undefined,
        message: { text: input.text, timestamp: input.timestamp },
      };
  return JSON.stringify({
    eventId: input.eventId,
    sessionId: input.sessionId,
    kind: input.kind,
    timestamp: input.timestamp,
    transport: input.transport,
    payload,
  });
}

test("queryMemory uses indexed app messages for earliest user evidence", () => {
  const db = createAppDb();
  insertChat(db, "general");
  insertMessage(db, {
    id: "assistant-startup",
    chatId: "general",
    role: "assistant",
    text: "Butler started",
    createdAt: "2026-04-24T12:26:33.548Z",
  });
  insertMessage(db, {
    id: "first-user",
    chatId: "general",
    role: "user",
    text: FIRST_USER_TEXT,
    createdAt: "2026-04-24T12:05:34.000Z",
  });
  insertMessage(db, {
    id: "second-user",
    chatId: "general",
    role: "user",
    text: SECOND_USER_TEXT,
    createdAt: "2026-04-24T12:27:10.000Z",
  });
  db.close();

  const result = queryMemory({
    butlerData: tempDir,
    speaker: "user",
    order: "earliest",
    limit: 1,
  });

  expect(result.skipped_sources).toContain("transcript-query-index: transcript query index missing");
  expect(result).toMatchObject({
    query: null,
    speaker: "user",
    order: "earliest",
    total_matches: 2,
    returned: 1,
  });
  expect(result.results[0]).toMatchObject({
    event_id: "first-user",
    session_id: "butler/app-general",
    timestamp: "2026-04-24T12:05:34.000Z",
    speaker: "user",
    kind: "inbound",
    text: FIRST_USER_TEXT,
    source: "app-message-db",
    transcript_file: null,
  });
});

test("queryMemory treats indexed app db as authoritative for app sessions", () => {
  const db = createAppDb();
  insertChat(db, "general");
  insertMessage(db, {
    id: "app-first-user",
    chatId: "general",
    role: "user",
    text: FIRST_USER_TEXT,
    createdAt: "2026-04-24T12:05:34.000Z",
  });
  db.close();
  indexTranscriptLinesForQuery({
    butlerData: tempDir,
    transcriptFile: "duplicate-app-transcript.jsonl",
    lines: [
      transcriptLine({
        eventId: "duplicate-app-user",
        sessionId: "butler/app-general",
        kind: "inbound",
        timestamp: "2026-04-24T12:05:34.000Z",
        text: FIRST_USER_TEXT,
      }),
      transcriptLine({
        eventId: "native-user",
        sessionId: "butler/main",
        kind: "inbound",
        timestamp: "2026-04-24T12:06:00.000Z",
        text: SECOND_USER_TEXT,
      }),
    ],
  });

  const result = queryMemory({
    butlerData: tempDir,
    speaker: "user",
    order: "earliest",
    limit: 10,
  });

  expect(result.total_matches).toBe(2);
  expect(result.results.map((item) => item.event_id)).toEqual([
    "app-first-user",
    "native-user",
  ]);

  const appSession = queryMemory({
    butlerData: tempDir,
    scope: "session",
    sessionId: "butler/app-general",
    speaker: "user",
    order: "earliest",
    limit: 10,
  });
  expect(appSession.total_matches).toBe(1);
  expect(appSession.skipped_sources).toContain(
    "transcript-query-index: app session covered by app message db",
  );
});

test("queryMemory refuses app message scans when required date indexes are missing", () => {
  const db = new Database(appDb, { create: true });
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.close();

  const result = queryMemory({
    butlerData: tempDir,
    speaker: "user",
    order: "earliest",
    limit: 1,
  });

  expect(result.returned).toBe(0);
  expect(result.skipped_sources).toContain(
    "app-message-db: messages_role_created_idx missing; refusing full message scan",
  );
});

test("queryMemory does not widen missing session scope into all sessions", () => {
  const db = createAppDb();
  insertChat(db, "general");
  insertMessage(db, {
    id: "first-user",
    chatId: "general",
    role: "user",
    text: FIRST_USER_TEXT,
    createdAt: "2026-04-24T12:05:34.000Z",
  });
  db.close();

  const result = queryMemory({
    butlerData: tempDir,
    scope: "session",
    speaker: "user",
    order: "earliest",
    limit: 1,
  });

  expect(result.returned).toBe(0);
  expect(result.total_matches).toBe(0);
  expect(result.diagnostics).toContain("session scope requested without session_id");
  expect(result.skipped_sources).toContain("app-message-db: session scope missing session_id");
});

test("queryMemory can filter indexed transcript text and excludes internal placeholders", () => {
  indexTranscriptLinesForQuery({
    butlerData: tempDir,
    transcriptFile: "synthetic.jsonl",
    lines: [
      transcriptLine({
        eventId: "tool-payload",
        sessionId: "butler/main",
        kind: "tool_result",
        timestamp: "2026-04-24T12:00:00.000Z",
        text: "자기소개 도구 출력은 대화 기억으로 세면 안 됩니다",
      }),
      transcriptLine({
        eventId: "mock-steward",
        sessionId: "steward/butler",
        kind: "inbound",
        timestamp: "1970-01-01T00:00:00.000Z",
        text: "SYNTHETIC_STEWARD_PLACEHOLDER",
        transport: "mock",
        routeRole: "steward",
        payloadEventId: "mock:project-memory-steward",
      }),
      transcriptLine({
        eventId: "main-intro",
        sessionId: "butler/main",
        kind: "inbound",
        timestamp: "2026-04-24T12:27:10.000Z",
        text: "합성 자기소개 요청",
      }),
      transcriptLine({
        eventId: "other-intro",
        sessionId: "butler/app-other",
        kind: "inbound",
        timestamp: "2026-04-25T10:00:00.000Z",
        text: "자기소개 대신 프로젝트 상태만 말해줘",
      }),
    ],
  });

  const result = queryMemory({
    butlerData: tempDir,
    query: "자기소개",
    scope: "session",
    sessionId: "butler/app-other",
    speaker: "user",
    order: "earliest",
    limit: 5,
  });

  expect(result.skipped_sources).toContain("app-message-db: app message db missing");
  expect(result).toMatchObject({
    query: "자기소개",
    scope: "session",
    session_id: "butler/app-other",
    total_matches: 1,
    returned: 1,
  });
  expect(result.results[0]?.event_id).toBe("other-intro");
  expect(result.results[0]?.source).toBe("transcript-query-index");
  expect(result.results[0]?.matched_terms).toContain("자기소개");

  const earliest = queryMemory({
    butlerData: tempDir,
    speaker: "user",
    order: "earliest",
    limit: 1,
  });
  expect(earliest.results[0]?.event_id).toBe("main-intro");
  expect(JSON.stringify(earliest.results)).not.toContain("tool-payload");
});

test("queryMemory supports latest ordering and parseable date ranges", () => {
  const db = createAppDb();
  insertChat(db, "general");
  insertMessage(db, {
    id: "old-user",
    chatId: "general",
    role: "user",
    text: "메모리 도구 이야기",
    createdAt: "2026-05-01T00:00:00.000Z",
  });
  insertMessage(db, {
    id: "new-user",
    chatId: "general",
    role: "user",
    text: "메모리 도구 query_memory 이야기",
    createdAt: "2026-05-20T00:00:00.000Z",
  });
  db.close();

  const result = queryMemory({
    butlerData: tempDir,
    query: "메모리 도구",
    speaker: "user",
    order: "latest",
    dateFrom: "2026-05-10T00:00:00.000Z",
    dateTo: "2026-05-20",
    limit: 5,
  });

  expect(result.total_matches).toBe(1);
  expect(result.results[0]?.event_id).toBe("new-user");
});

test("message date queries use indexes instead of scanning message rows", () => {
  const db = createAppDb();
  insertChat(db, "general");
  const insert = db.query(`
    INSERT INTO messages (id, chat_id, role, text, status, created_at, updated_at)
    VALUES (?, 'general', ?, ?, 'sent', ?, ?)
  `);
  const insertMany = db.transaction(() => {
    for (let index = 0; index < 5000; index += 1) {
      const role = index % 2 === 0 ? "user" : "assistant";
      const createdAt = `2026-05-25T${String(Math.floor(index / 3600)).padStart(2, "0")}:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
      insert.run(`m${index}`, role, `synthetic ${index}`, createdAt, createdAt);
    }
  });
  insertMany();
  const plan = db.query<{ detail: string }, []>(`
    EXPLAIN QUERY PLAN
    SELECT id
    FROM messages
    WHERE role = 'user'
      AND created_at >= '2026-05-25T00:10:00.000Z'
      AND created_at < '2026-05-25T00:20:00.000Z'
    ORDER BY created_at ASC
    LIMIT 10
  `).all().map((row) => row.detail).join("\n");
  db.close();

  expect(plan).toContain("USING");
  expect(plan).toContain("messages_role_created_idx");
  expect(plan).not.toContain("SCAN messages");
});

test("transcript query index date queries use indexes instead of scanning jsonl", () => {
  const lines = Array.from({ length: 2000 }, (_, index) =>
    transcriptLine({
      eventId: `event-${index}`,
      sessionId: "butler/main",
      kind: index % 2 === 0 ? "inbound" : "outbound",
      timestamp: `2026-05-25T00:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      text: `synthetic transcript ${index}`,
    }),
  );
  indexTranscriptLinesForQuery({
    butlerData: tempDir,
    transcriptFile: "synthetic.jsonl",
    lines,
  });
  const db = new Database(transcriptQueryDbPath(tempDir), { readonly: true });
  const plan = db.query<{ detail: string }, []>(`
    EXPLAIN QUERY PLAN
    SELECT source_id
    FROM conversation_messages
    WHERE role = 'user'
      AND created_at >= '2026-05-25T00:10:00.000Z'
      AND created_at < '2026-05-25T00:20:00.000Z'
    ORDER BY created_at ASC
    LIMIT 10
  `).all().map((row) => row.detail).join("\n");
  db.close();

  expect(plan).toContain("USING");
  expect(plan).toContain("conversation_messages_role_created_idx");
  expect(plan).not.toContain("SCAN conversation_messages");
});
