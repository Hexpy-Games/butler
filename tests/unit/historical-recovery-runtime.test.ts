import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHistoricalRecoveryReport,
  classifyHistoricalRows,
  readHistoricalAppProjectionRows,
  readHistoricalTranscriptRows,
  runHistoricalConversationRecovery,
} from "../../packages/butler-agent/src/agent/conversation/historical-recovery.ts";
import { conversationSessionIdForDurableSession } from "../../packages/butler-agent/src/agent/conversation/session-admission.ts";
import { readConversationObservations } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/conversation-sources.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-historical-recovery-runtime-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("historical recovery imports only trusted or recovered rows and is idempotent", () => {
  const recoveredText = "RECOVERED_CANONICAL_TEXT";
  const ambiguousText = "AMBIGUOUS_TEXT_MUST_NOT_ENTER_STORE";
  const first = runHistoricalConversationRecovery({
    butlerData: tempDir,
    dryRun: false,
    transcriptRows: [
      transcriptRow({
        eventId: "evt-recovered",
        sessionId: "legacy/session",
        kind: "inbound",
        text: recoveredText,
      }),
      {
        eventId: "evt-ambiguous",
        sessionId: "legacy/session",
        kind: "turn",
        timestamp: "2026-07-02T00:00:02.000Z",
        payload: { text: ambiguousText },
      },
    ],
    appRows: [{
      id: "app-trusted",
      chat_id: "general",
      role: "assistant",
      text: "trusted answer",
      created_at: "2026-07-02T00:00:03.000Z",
      conversation_session_id: "cs_trusted_app",
      conversation_turn_id: "ct_trusted_app",
      conversation_message_id: "cm_trusted_app",
    }],
  });
  const second = runHistoricalConversationRecovery({
    butlerData: tempDir,
    dryRun: false,
    transcriptRows: [
      transcriptRow({
        eventId: "evt-recovered",
        sessionId: "legacy/session",
        kind: "inbound",
        text: recoveredText,
      }),
    ],
    appRows: [{
      id: "app-trusted",
      chat_id: "general",
      role: "assistant",
      text: "trusted answer",
      created_at: "2026-07-02T00:00:03.000Z",
      conversation_session_id: "cs_trusted_app",
      conversation_turn_id: "ct_trusted_app",
      conversation_message_id: "cm_trusted_app",
    }],
  });
  const recoveredSessionId = conversationSessionIdForDurableSession("legacy/session");
  const observations = readConversationObservations({
    butlerData: tempDir,
    includeCompacted: true,
    order: "asc",
  });

  expect(first.counts).toMatchObject({
    recovered: 1,
    trusted: 1,
    ambiguous: 1,
    imported: 2,
  });
  expect(second.counts).toMatchObject({
    skipped_existing: 2,
    imported: 0,
  });
  expect(observations.map((observation) => ({
    session: observation.conversation_session_id,
    turn: observation.conversation_turn_id,
    message: observation.conversation_message_id,
    role: observation.role,
    provenance: observation.provenance,
    text: observation.text,
    auditRefs: observation.audit_refs,
  }))).toEqual(expect.arrayContaining([
    {
      session: recoveredSessionId,
      turn: expect.stringMatching(/^ct_recovered_/),
      message: expect.stringMatching(/^cm_recovered_/),
      role: "user",
      provenance: "recovered",
      text: recoveredText,
      auditRefs: expect.arrayContaining([expect.stringMatching(/^recovery:transcript:[0-9a-f]{32}$/)]),
    },
    {
      session: "cs_trusted_app",
      turn: "ct_trusted_app",
      message: "cm_trusted_app",
      role: "assistant",
      provenance: "trusted",
      text: "trusted answer",
      auditRefs: expect.arrayContaining([expect.stringMatching(/^recovery:app_projection:[0-9a-f]{32}$/)]),
    },
  ]));
  expect(JSON.stringify(observations)).not.toContain(ambiguousText);
  expect(JSON.stringify(observations)).not.toContain("evt-recovered");
  expect(JSON.stringify(observations)).not.toContain("app-trusted");
});

test("historical recovery reports the existing source mapping when canonical refs arrive later", () => {
  const first = runHistoricalConversationRecovery({
    butlerData: tempDir,
    dryRun: false,
    appRows: [{
      id: "app-late-canonical",
      chat_id: "general",
      role: "assistant",
      text: "legacy answer",
      created_at: "2026-07-02T00:00:03.000Z",
    }],
  });
  const second = runHistoricalConversationRecovery({
    butlerData: tempDir,
    dryRun: false,
    appRows: [{
      id: "app-late-canonical",
      chat_id: "general",
      role: "assistant",
      text: "legacy answer",
      created_at: "2026-07-02T00:00:03.000Z",
      conversation_session_id: "cs_late_canonical",
      conversation_message_id: "cm_should_not_replace_existing_source",
    }],
  });

  expect(first.mappings[0]?.conversation_message_id).toMatch(/^conversation_message:[0-9a-f]{16}$/);
  expect(second.counts).toMatchObject({ imported: 0, skipped_existing: 1 });
  expect(second.mappings[0]).toMatchObject({
    source_kind: "app_projection",
    source_id: expect.stringMatching(/^app_projection:[0-9a-f]{16}$/),
    status: "existing",
    conversation_message_id: first.mappings[0]?.conversation_message_id,
  });
});

test("historical recovery source refs are session-scoped and do not collide on reused event ids", () => {
  const result = runHistoricalConversationRecovery({
    butlerData: tempDir,
    dryRun: false,
    transcriptRows: [
      transcriptRow({
        eventId: "shared-event-id",
        sessionId: "legacy/a",
        kind: "inbound",
        text: "first recovered text",
      }),
      transcriptRow({
        eventId: "shared-event-id",
        sessionId: "legacy/b",
        kind: "inbound",
        text: "second recovered text",
      }),
    ],
  });
  const observations = readConversationObservations({
    butlerData: tempDir,
    includeCompacted: true,
    order: "asc",
  });

  expect(result.counts).toMatchObject({ imported: 2, skipped_existing: 0 });
  expect(observations).toHaveLength(2);
  expect(new Set(observations.map((observation) => observation.audit_refs[0]))).toHaveLength(2);
  expect(JSON.stringify(observations)).not.toContain("shared-event-id");
});

test("historical app projection reader tolerates legacy and canonical schemas", () => {
  const dbPath = join(tempDir, "app.sqlite");
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT,
        created_at TEXT NOT NULL,
        conversation_session_id TEXT,
        conversation_turn_id TEXT,
        conversation_message_id TEXT
      );
    `);
    db.query(`
      INSERT INTO messages (
        id, chat_id, role, text, created_at, conversation_session_id, conversation_turn_id, conversation_message_id
      ) VALUES ('m1', 'general', 'user', 'hello', '2026-07-02T00:00:00.000Z', 'cs1', 'ct1', 'cm1')
    `).run();
  } finally {
    db.close();
  }

  expect(readHistoricalAppProjectionRows(dbPath)).toEqual([{
    id: "m1",
    chat_id: "general",
    role: "user",
    text: "hello",
    created_at: "2026-07-02T00:00:00.000Z",
    conversation_session_id: "cs1",
    conversation_turn_id: "ct1",
    conversation_message_id: "cm1",
  }]);
});

test("historical transcript reader counts malformed jsonl as ambiguous without leaking content", () => {
  const transcriptPath = join(tempDir, "legacy.jsonl");
  const secretMalformed = "SECRET_IN_MALFORMED_LINE";
  writeFileSync(transcriptPath, [
    JSON.stringify(transcriptRow({
      eventId: "evt-good",
      sessionId: "legacy/session",
      kind: "inbound",
      text: "good text",
    })),
    `{not-json:${secretMalformed}}`,
  ].join("\n"), "utf8");

  const decisions = classifyHistoricalRows({
    transcriptRows: readHistoricalTranscriptRows(transcriptPath),
  });
  const report = buildHistoricalRecoveryReport({ decisions, dryRun: true });

  expect(report.counts).toMatchObject({
    total: 2,
    recovered: 1,
    ambiguous: 1,
  });
  expect(report.rows.map((row) => row.reason)).toEqual([
    "clean_transcript_message_recovered",
    "missing_stable_transcript_identity",
  ]);
  expect(JSON.stringify(report)).not.toContain(secretMalformed);
});

function transcriptRow(input: {
  eventId: string;
  sessionId: string;
  kind: string;
  text: string;
  transport?: string;
}) {
  return {
    eventId: input.eventId,
    sessionId: input.sessionId,
    kind: input.kind,
    timestamp: "2026-07-02T00:00:01.000Z",
    transport: input.transport,
    payload: {
      eventId: input.transport === "mock" ? "mock:placeholder" : input.eventId,
      message: {
        text: input.text,
        timestamp: "2026-07-02T00:00:01.000Z",
      },
    },
  };
}
