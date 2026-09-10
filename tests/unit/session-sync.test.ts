import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import {
  appendSessionSyncDiagnostic,
  prepareTempIndexInputPath,
  runSessionSync,
} from "../../packages/butler-agent/src/agent/cognition/memory/scripts/session-sync.ts";
import { activeMemoryDescriptorPath, initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { readMemoryHealth } from "../../packages/butler-agent/src/agent/cognition/memory/quality.ts";
import { runCanonicalMemoryCatchup } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/phases/catchup.ts";
import { Database } from "bun:sqlite";
import {
  buildMemoryConversationObservationPayload,
  buildMemoryTranscriptPayload,
} from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/ingestion.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { extractSourceMessageIdsFromJsonl } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/index.ts";
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

test("canonical conversation observation payload carries source message ids", () => {
  const butlerData = join(tmpdir(), `butler-session-sync-canonical-${Date.now()}-${Math.random()}`);
  let next = 0;
  const store = new AgentConversationStore({
    butlerData,
    idFactory: (prefix) => `${prefix}_sync_${++next}`,
  });
  try {
    const turn = store.beginTurn({
      gateway: "app",
      externalSessionId: "general",
      sessionId: "cs_sync",
      actor: "user",
      now: "2026-07-02T00:00:00.000Z",
    });
    store.appendUserMessage({
      sessionId: "cs_sync",
      turnId: turn.id,
      messageId: "cm_sync_user",
      text: "canonical user text",
      now: "2026-07-02T00:00:01.000Z",
    });
    store.appendAssistantMessage({
      sessionId: "cs_sync",
      turnId: turn.id,
      messageId: "cm_sync_assistant",
      text: "canonical assistant text",
      now: "2026-07-02T00:00:02.000Z",
    });
  } finally {
    store.close();
  }

  try {
    const payload = buildMemoryConversationObservationPayload({
      butlerData,
      sourceSessionId: "cs_sync",
    });

    expect(payload).toMatchObject({
      sourceSessionId: "cs_sync",
      conversationSessionId: "cs_sync",
      messageCount: 2,
    });
    expect(payload.chunks[0]?.sourceMessageIds).toEqual(["cm_sync_user", "cm_sync_assistant"]);
    expect(payload.chunks[0]?.conversationText).toContain("user: canonical user text");
    expect(payload.chunks[0]?.indexJsonl).toContain("\"source_message_ids\":[\"cm_sync_user\"]");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("memory index input exposes canonical source message ids for provenance", () => {
  const jsonl = [
    JSON.stringify({ type: "user", source_message_ids: ["cm_a", "cm_b"], message: { role: "user", content: "a" } }),
    JSON.stringify({ type: "assistant", source_message_ids: ["cm_b", "cm_c"], message: { role: "assistant", content: [{ type: "text", text: "b" }] } }),
  ].join("\n");

  expect(extractSourceMessageIdsFromJsonl(jsonl)).toEqual(["cm_a", "cm_b", "cm_c"]);
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

test("scheduled session sync uses canonical catchup before legacy transcript side effects", async () => {
  const butlerData = join(tmpdir(), `butler-session-sync-v2-${Date.now()}-${Math.random()}`);
  try {
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const store = new AgentConversationStore({ butlerData });
    try {
      store.beginTurn({ gateway: "app", externalSessionId: "scheduled", sessionId: "cs_scheduled", actor: "user", turnId: "turn_scheduled" });
      const request = store.appendUserMessage({ sessionId: "cs_scheduled", turnId: "turn_scheduled", text: "remember the canonical source", originKind: "user_input", originRef: "test" });
      const assistant = store.appendAssistantMessage({ sessionId: "cs_scheduled", turnId: "turn_scheduled", text: "canonical acknowledgement", originKind: "assistant_public", originRef: "test" });
      store.finalizeTurn({ turnId: "turn_scheduled", status: "complete", outcomeCapsule: {
        sessionId: "cs_scheduled", turnId: "turn_scheduled", generation: 1, outcome: "delivered", requestMessageId: request.id, publicAssistantMessageId: assistant.id,
      } });
    } finally { store.close(); }
    const before = readMemoryHealth({ butlerData }).serving;
    expect(before.sources).toMatchObject({ eligible: null, known_eligible: 2, registered_current: 0,
      inventory_complete: false, inventory_reason: "typed_inventory_unavailable", known_coverage_percent: 0 });
    const result = await runSessionSync({ butlerData });
    expect(result).toMatchObject({ available: true, scanned: 1, ingested: 1 });
    const graph = new Database(join(butlerData, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite"), { readonly: true });
    expect(graph.query<{ count: number }, []>("SELECT COUNT(*) count FROM memory_chunk_sources").get()?.count).toBeGreaterThan(0);
    expect(graph.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='canonical_catchup_outcome_cursor'").get()?.value).toBeTruthy();
    graph.close();
    expect(existsSync(join(butlerData, "cognition", "memory", "db", "session-sync-offset.json"))).toBe(false);
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

test("scheduled session sync never falls back to legacy writes for an existing invalid v2 descriptor", async () => {
  const butlerData = join(tmpdir(), `butler-session-sync-invalid-v2-${Date.now()}-${Math.random()}`);
  try {
    initializeEmptyMemoryGeneration(butlerData);
    writeFileSync(activeMemoryDescriptorPath(butlerData), "{}\n", "utf8");
    await expect(runSessionSync({ butlerData })).rejects.toThrow("memory_generation_unavailable");
    expect(existsSync(join(butlerData, "cognition", "memory", "db", "session-sync-offset.json"))).toBe(false);
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

test("canonical catchup reports unavailable source owner distinctly from empty", async () => {
  const butlerData = join(tmpdir(), `butler-session-sync-unavailable-${Date.now()}-${Math.random()}`);
  try {
    const result = await runCanonicalMemoryCatchup({ butlerData, state: { outcomeCursor: null, recoveredMessageCursor: null },
      ingest: async () => { throw new Error("must not ingest"); } });
    expect(result).toMatchObject({ available: false, reason: "canonical_reader_unavailable", scanned: 0, ingested: 0 });
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});
