import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRANSCRIPT_TOP_LEVEL_EVENT_KINDS } from "../../packages/butler-agent/src/agent/conversation/admission-kinds.ts";
import {
  buildHistoricalRecoveryReport,
  classifyHistoricalAppProjectionRow,
  classifyHistoricalTranscriptRow,
  classifyHistoricalRows,
  runHistoricalConversationRecovery,
} from "../../packages/butler-agent/src/agent/conversation/historical-recovery.ts";
import { readConversationObservations } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/conversation-sources.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-historical-recovery-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("historical transcript classifier reports recovered discarded and ambiguous without raw text", () => {
  const privateText = "PRIVATE_TRANSCRIPT_TEXT_SHOULD_NOT_APPEAR";
  const decisions = classifyHistoricalRows({
    transcriptRows: [
      transcriptRow({
        eventId: "evt-user",
        sessionId: "legacy/session",
        kind: "inbound",
        text: privateText,
      }),
      transcriptRow({
        eventId: "evt-delivery",
        sessionId: "legacy/session",
        kind: "delivery",
        text: "delivery payload",
      }),
      {
        eventId: "evt-turn",
        sessionId: "legacy/session",
        kind: "turn",
        timestamp: "2026-07-02T00:00:03.000Z",
        payload: { text: "turn payload must not be parsed as message" },
      },
      transcriptRow({
        eventId: "mock-placeholder",
        sessionId: "legacy/session",
        kind: "inbound",
        text: "mock placeholder",
        transport: "mock",
      }),
    ],
  });
  const report = buildHistoricalRecoveryReport({ decisions, dryRun: true });

  expect(report.counts).toMatchObject({
    total: 4,
    recovered: 1,
    discarded: 2,
    ambiguous: 1,
    admissible: 1,
  });
  expect(report.rows.map((row) => row.reason)).toEqual([
    "clean_transcript_message_recovered",
    "transcript_kind_not_semantic",
    "turn_text_requires_explicit_recovery_policy",
    "transcript_placeholder_or_internal",
  ]);
  expect(JSON.stringify(report)).not.toContain(privateText);
  expect(report.privacy).toEqual({ rawTextIncluded: false, secretsIncluded: false });
});

test("historical transcript classifier covers every current top-level transcript kind", () => {
  const decisions = TRANSCRIPT_TOP_LEVEL_EVENT_KINDS.map((kind) =>
    classifyHistoricalTranscriptRow(transcriptRow({
      eventId: `evt-${kind}`,
      sessionId: "legacy/kinds",
      kind,
      text: "semantic text",
    })),
  );

  expect(decisions.map((decision) => [decision.provenance, decision.admit, decision.reason])).toEqual([
    ["recovered", true, "clean_transcript_message_recovered"],
    ["recovered", true, "clean_transcript_message_recovered"],
    ["discarded", false, "transcript_kind_not_semantic"],
    ["ambiguous", false, "turn_text_requires_explicit_recovery_policy"],
    ["ambiguous", false, "historical_tool_or_unknown_requires_review"],
    ["ambiguous", false, "historical_tool_or_unknown_requires_review"],
    ["discarded", false, "transcript_kind_not_semantic"],
    ["discarded", false, "transcript_kind_not_semantic"],
    ["discarded", false, "transcript_kind_not_semantic"],
    ["discarded", false, "transcript_kind_not_semantic"],
  ]);
});

test("historical app projection classifier distinguishes trusted recovered discarded and ambiguous rows", () => {
  expect(classifyHistoricalAppProjectionRow({
    id: "app-trusted",
    chat_id: "general",
    role: "user",
    text: "trusted app text",
    created_at: "2026-07-02T00:00:01.000Z",
    conversation_session_id: "cs_app",
    conversation_message_id: "cm_app",
  })).toMatchObject({
    provenance: "trusted",
    admit: true,
    conversation_session_id: "cs_app",
    conversation_message_id: "cm_app",
  });
  expect(classifyHistoricalAppProjectionRow({
    id: "app-recovered",
    chat_id: "general",
    role: "assistant",
    text: "legacy answer",
    created_at: "2026-07-02T00:00:02.000Z",
  })).toMatchObject({
    provenance: "recovered",
    admit: true,
    session_id: "butler/app-general",
  });
  expect(classifyHistoricalAppProjectionRow({
    id: "app-activity",
    chat_id: "general",
    role: "system_event",
    text: "activity only",
    created_at: "2026-07-02T00:00:03.000Z",
  })).toMatchObject({
    provenance: "discarded",
    admit: false,
  });
  expect(classifyHistoricalAppProjectionRow({
    id: "app-unknown",
    chat_id: "general",
    role: "future_role",
    text: "unknown future role",
    created_at: "2026-07-02T00:00:04.000Z",
  })).toMatchObject({
    provenance: "ambiguous",
    admit: false,
  });
});

test("historical recovery dry-run does not write semantic rows and reports only safe ids", () => {
  const secret = "DRY_RUN_SECRET_TEXT";
  const secretEventId = "SECRET_IN_EVENT_ID_AND_SESSION";
  const secretSessionId = "legacy/SECRET_IN_SESSION_ID";
  const report = runHistoricalConversationRecovery({
    butlerData: tempDir,
    dryRun: true,
    transcriptRows: [
      transcriptRow({
        eventId: secretEventId,
        sessionId: secretSessionId,
        kind: "inbound",
        text: secret,
      }),
    ],
  });

  expect(report.counts).toMatchObject({
    recovered: 1,
    admissible: 1,
    imported: 0,
    skipped_existing: 0,
  });
  expect(report.mappings[0]).toMatchObject({
    source_kind: "transcript",
    source_id: expect.stringMatching(/^transcript:[0-9a-f]{16}$/),
    status: "planned",
  });
  expect(JSON.stringify(report)).not.toContain(secret);
  expect(JSON.stringify(report)).not.toContain(secretEventId);
  expect(JSON.stringify(report)).not.toContain(secretSessionId);
  expect(readConversationObservations({ butlerData: tempDir })).toEqual([]);
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
