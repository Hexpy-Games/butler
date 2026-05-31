import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import {
  appendSessionSyncDiagnostic,
  prepareTempIndexInputPath,
} from "../../packages/butler-agent/src/agent/cognition/memory/scripts/session-sync.ts";
import {
  buildMemoryTranscriptPayload,
} from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/ingestion.ts";
import {
  normalizeSessionIdForStorage,
  transcriptFileNameForSessionId,
} from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/session-id.ts";

test("session sync prepares parent directories for slash-delimited session ids", () => {
  const path = prepareTempIndexInputPath("butler/main_c0");
  expect(path).toContain("butler-session-sync-butler_main_c0.jsonl");
  expect(existsSync(dirname(path))).toBe(true);
});

test("native transcript normalization preserves original session id and stores safe ids", () => {
  const payload = buildMemoryTranscriptPayload({
    sourceSessionId: "butler/main",
    chunkByGap: true,
    lines: [
      JSON.stringify({
        eventId: "evt-1",
        sessionId: "butler/main",
        kind: "inbound",
        timestamp: "2026-04-26T10:00:00.000Z",
        payload: { message: { text: "떡볶이 먹고 싶다" } },
      }),
      JSON.stringify({
        eventId: "evt-2",
        sessionId: "butler/main",
        kind: "outbound",
        timestamp: "2026-04-26T10:00:10.000Z",
        payload: { message: { text: "지난번 결정과 식단 목표를 함께 보겠습니다." } },
      }),
    ],
  });

  expect(payload.messageCount).toBe(2);
  expect(payload.chunks[0]?.sessionId).toEqual({
    original: "butler/main",
    storage: "butler_main_c0",
  });
  expect(payload.chunks[0]?.conversationText).toContain("user: 떡볶이 먹고 싶다");
  expect(payload.chunks[0]?.indexJsonl).toContain("\"type\":\"user\"");
  expect(normalizeSessionIdForStorage("butler/main")).toBe("butler_main");
  expect(transcriptFileNameForSessionId("butler/main")).toBe("butler_main.jsonl");
});

test("session sync records diagnostics for non-indexable transcript lines", () => {
  const butlerData = join(tmpdir(), `butler-session-sync-diag-${Date.now()}-${Math.random()}`);
  const dlqFile = join(butlerData, "cognition", "memory", "queue", "dead-letter.jsonl");

  try {
    const payload = buildMemoryTranscriptPayload({
      sourceSessionId: "butler/main",
      chunkByGap: true,
      lines: ["{\"not\":\"a transcript event\"}"],
    });
    expect(payload.messageCount).toBe(0);
    expect(payload.chunks).toHaveLength(0);
    appendSessionSyncDiagnostic({
      reason: "session_sync_unparseable_transcript",
      session_id: "butler/main",
      project: "butler",
      line_count: 1,
    }, dlqFile);
    expect(readFileSync(dlqFile, "utf8")).toContain("session_sync_unparseable_transcript");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
