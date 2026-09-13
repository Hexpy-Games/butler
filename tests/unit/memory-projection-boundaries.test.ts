import { insertMemoryNodeFixture } from "../helpers/memory-node-fixture.ts";
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { ingestConversationMemory, advanceNextMemoryProjection } from "../../packages/butler-agent/src/agent/cognition/memory/index.ts";
import { splitGraphemeUtf8Spans } from "../../packages/butler-agent/src/agent/cognition/memory/projection/windows.ts";
import { installAndBackfillRecallIndexes } from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";
import { unicodeCaseFold } from "../../packages/butler-agent/src/agent/cognition/memory/projection/unicode.ts";
import { OPENAI_PROVIDER_ADAPTER } from "../../packages/butler-agent/src/integrations/providers/openai/adapter.ts";

async function fixture(text: string) {
  const root = mkdtempSync(join(tmpdir(), "memory-boundary-"));
  const descriptor = initializeEmptyMemoryGeneration(root);
  const context = { butlerData: root, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: AbortSignal.timeout(30000) };
  const store = new AgentConversationStore({ butlerData: root });
  const turn = store.beginTurn({ gateway: "app", externalSessionId: "session", sessionId: "session", projectId: null, actor: "user", turnId: "turn" });
  const user = store.appendUserMessage({ sessionId: "session", turnId: turn.id, text: "Remember this.", originKind: "user_input", originRef: "app:turn:user" });
  const assistant = store.appendAssistantMessage({ sessionId: "session", turnId: turn.id, text, originKind: "assistant_public", originRef: "app:turn:assistant" });
  store.finalizeTurn({ turnId: turn.id, status: "complete", outcomeCapsule: { sessionId: "session", turnId: turn.id, generation: 1, outcome: "delivered", requestMessageId: user.id, publicAssistantMessageId: assistant.id, providerId: "test", modelRef: "test/model" } });
  store.close();
  await ingestConversationMemory({ context, source: { kind: "conversation_turn", session_id: "session", turn_id: "turn", outcome_generation: 1 } });
  const db = new Database(join(root, "cognition/memory/generations", descriptor.generation_id, "graph.sqlite"));
  return { root, context, db, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("UTF8 overflow starts the next chunk without emitting a boundary character chunk", () => {
  for (const text of ["a".repeat(32), "한글👩🏽‍🚀cafe\u0301".repeat(5)]) {
    const spans = splitGraphemeUtf8Spans(text, 16), bytes = Buffer.from(text);
    expect(spans.map(s => bytes.subarray(s.start, s.end).toString()).join("")).toBe(text);
    expect(spans.every(s => s.end - s.start <= 16 || s.oversized)).toBe(true);
    if (text.startsWith("a")) expect(spans.map(s => s.end - s.start)).toEqual([16, 16]);
  }
});

test("public legacy boundary recovery expands context, preserves coverage and records exact cross-source evidence", async () => {
  const f = await fixture("x ".repeat(4090) + "The server uses port 2222.");
  const original = OPENAI_PROVIDER_ADAPTER.runPrompt;
  const prompts: any[] = [];
  OPENAI_PROVIDER_ADAPTER.runPrompt = async request => {
    const p = JSON.parse(request.prompt); prompts.push(p);
    expect(p.parts).toHaveLength(1);
    expect(p.parts[0].text).toHaveLength(1);
    const value = prompts.length === 1 ? { status: "needs_context", entities: [], items: [], attributes: [] }
      : { status: "processed", entities: [], items: [{ kind: "fact", subject: null, text: "The server uses port 2222.", evidence: [0] }], attributes: [] };
    return { text: JSON.stringify(value), model: "gpt-5.6-sol", usage: null } as never;
  };
  try {
    const source = f.db.query<any, []>("SELECT source_id FROM memory_chunk_sources WHERE byte_start=8192 AND byte_end=8193").get();
    const window = f.db.query<any, [string]>("SELECT * FROM memory_projection_windows WHERE source_refs_json=?").get(JSON.stringify([source.source_id]));
    // Preserve previously completed allocations around the historical boundary row.
    f.db.query("UPDATE memory_projection_windows SET state='complete' WHERE window_ref!=?").run(window.window_ref);
    const completed = f.db.query("SELECT * FROM memory_projection_windows WHERE state='complete'").all();
    const sources = f.db.query("SELECT * FROM memory_chunk_sources ORDER BY source_id").all();
    await advanceNextMemoryProjection({ context: f.context });
    const revised = f.db.query<any, [string]>("SELECT state,error_code,input_json FROM memory_projection_windows WHERE window_ref=?").get(window.window_ref);
    expect(revised.state).toBe("pending"); expect(revised.error_code).toBeNull();
    expect(JSON.parse(revised.input_json).context_expansion).toBe(1);
    const receipt = f.db.query<any, []>("SELECT recovery_request_json FROM memory_projection_attempts WHERE attempt_kind='recovery'").get();
    const revision = JSON.parse(receipt.recovery_request_json);
    expect(revision.previous_input_sha256).not.toBe(revision.next_input_sha256);
    f.db.query("UPDATE memory_projection_jobs SET next_stage='semantic_graph'").run();
    for (let n = 0; n < 6; n++) {
      const state = f.db.query<any, [string]>("SELECT state FROM memory_projection_windows WHERE window_ref=?").get(window.window_ref).state;
      if (state === "complete" || state === "failed") break;
      await advanceNextMemoryProjection({ context: f.context });
    }
    expect(f.db.query<any, [string]>("SELECT state,error_code FROM memory_projection_windows WHERE window_ref=?").get(window.window_ref)).toEqual({ state: "complete", error_code: null });
    expect(prompts).toHaveLength(2);
    expect(prompts[1].parts[0].before.length).toBeGreaterThan(prompts[0].parts[0].before.length);
    expect(prompts[1].parts[0].before + prompts[1].parts[0].text + prompts[1].parts[0].after).toContain("The server uses port 2222.");
    expect(f.db.query("SELECT * FROM memory_projection_windows WHERE window_ref!=?").all(window.window_ref)).toEqual(completed);
    expect(f.db.query("SELECT * FROM memory_chunk_sources ORDER BY source_id").all()).toEqual(sources);
    expect(f.db.query<any, []>("SELECT count(DISTINCT source_id) n FROM memory_evidence").get().n).toBeGreaterThan(1);
    expect(f.db.query<any, []>("SELECT count(*) n FROM memory_projection_attempts WHERE state='failed'").get().n).toBe(0);
    f.db.query("UPDATE memory_projection_jobs SET next_stage='hot_cache'").run();
    await advanceNextMemoryProjection({ context: f.context });
    const cache = f.db.query<any, []>("SELECT hot_cache_state,hot_cache_receipt_json FROM memory_projection_jobs LIMIT 1").get();
    expect(JSON.parse(cache.hot_cache_state).state).toBe("complete");
    expect(JSON.parse(cache.hot_cache_receipt_json).entries.length).toBeGreaterThan(0);
    // An invented quote is still a real error, never a normal cache exclusion.
    const stored = f.db.query<any, [string]>("SELECT output_json FROM memory_projection_windows WHERE window_ref=?").get(window.window_ref);
    const corrupt = JSON.parse(stored.output_json); corrupt.summary.evidence[0].quote = "not present in the canonical source";
    f.db.query("UPDATE memory_projection_windows SET output_json=? WHERE window_ref=?").run(JSON.stringify(corrupt), window.window_ref);
    f.db.query("UPDATE memory_projection_jobs SET next_stage='hot_cache',hot_cache_state=?,hot_cache_attempt_count=2").run(JSON.stringify({ state: "pending", blocked_by: null }));
    await advanceNextMemoryProjection({ context: f.context });
    const rejected = f.db.query<any, []>("SELECT hot_cache_state,hot_cache_receipt_json FROM memory_projection_jobs LIMIT 1").get();
    expect(JSON.parse(rejected.hot_cache_state).state).toBe("failed");
    expect(JSON.parse(rejected.hot_cache_receipt_json).outcome).toBe("failed");
  } finally { OPENAI_PROVIDER_ADAPTER.runPrompt = original; f.close(); }
}, 30000);

test("incremental alias index handles updates, scope moves and deletion without touching unrelated postings", async () => {
  const f = await fixture("Hello");
  try {
    const source = f.db.query<any, []>("SELECT source_id FROM memory_chunk_sources LIMIT 1").get().source_id;
    installAndBackfillRecallIndexes(f.db);
    for (const [id, label] of [["one", "한글"], ["two", "العربية"]]) {
      insertMemoryNodeFixture(f.db, { id: id, type: "entity", label_original: label, claim: "{}", identity_scope: "user", created_at: "2026-09-12" });
      f.db.query("INSERT INTO memory_aliases(node_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,?,?,?,?,'create')").run(id, label, label, unicodeCaseFold(label!), source);
    }
    installAndBackfillRecallIndexes(f.db);
    const unchanged = f.db.query("SELECT rowid,* FROM memory_alias_postings WHERE node_id='two' ORDER BY gram").all();
    f.db.query("UPDATE memory_aliases SET folded_key='日本語' WHERE node_id='one'").run();
    f.db.query("UPDATE memory_nodes SET identity_scope='project',project_id='project' WHERE id='one'").run();
    expect(f.db.query<any, []>("SELECT count(*) n FROM memory_alias_index_dirty").get().n).toBe(1);
    installAndBackfillRecallIndexes(f.db);
    expect(f.db.query<any, []>("SELECT DISTINCT identity_scope,project_id FROM memory_alias_postings WHERE node_id='one'").all()).toEqual([{ identity_scope: "project", project_id: "project" }]);
    expect(f.db.query("SELECT rowid,* FROM memory_alias_postings WHERE node_id='two' ORDER BY gram").all()).toEqual(unchanged);
    const count = f.db.query<any, []>("SELECT total_changes() n").get().n;
    installAndBackfillRecallIndexes(f.db);
    expect(f.db.query<any, []>("SELECT total_changes() n").get().n).toBe(count);
    f.db.query("DELETE FROM memory_aliases WHERE node_id='one'").run();
    expect(f.db.query<any, []>("SELECT count(*) n FROM memory_alias_postings WHERE node_id='one'").get().n).toBe(0);
  } finally { f.close(); }
});


test("unsupported and exhausted context remain explicit incomplete results", async () => {
  const original = OPENAI_PROVIDER_ADAPTER.runPrompt;
  try {
    for (const status of ["unsupported", "needs_context"] as const) {
      const f = await fixture("short text");
      let calls = 0;
      OPENAI_PROVIDER_ADAPTER.runPrompt = async () => { calls++; return { text: JSON.stringify({ status, entities: [], items: [], attributes: [] }), model: "gpt-5.6-sol", usage: null } as never; };
      try {
        const w = f.db.query<any, []>("SELECT window_ref FROM memory_projection_windows ORDER BY ordinal LIMIT 1").get();
        f.db.query("UPDATE memory_projection_windows SET state='complete' WHERE window_ref!=?").run(w.window_ref);
        for (let n = 0; n < 3; n++) {
          f.db.query("UPDATE memory_projection_jobs SET next_stage='semantic_graph'").run();
          await advanceNextMemoryProjection({ context: f.context });
          if (f.db.query<any, [string]>("SELECT state FROM memory_projection_windows WHERE window_ref=?").get(w.window_ref).state === "unsupported") break;
        }
        const result = f.db.query<any, [string]>("SELECT state,error_code,output_json,provider_evidence_json FROM memory_projection_windows WHERE window_ref=?").get(w.window_ref);
        expect(result.state).toBe("unsupported"); expect(result.error_code).toBeNull();
        expect(result.output_json).toBeNull(); expect(JSON.parse(result.provider_evidence_json).warnings).toEqual([{ code: status }]);
        expect(f.db.query<any, []>("SELECT COUNT(*) n FROM memory_projection_attempts WHERE state='failed'").get().n).toBe(0);
        const semantic = JSON.parse(f.db.query<any, []>("SELECT semantic_graph_state FROM memory_projection_jobs LIMIT 1").get().semantic_graph_state);
        expect(semantic.failed_units).toBe(0); expect(semantic.warning_units).toBe(1); expect(semantic.pending_units).toBe(0);
        expect(calls).toBe(1); // Identical prompts reuse the saved result instead of re-calling the model.
      } finally { f.close(); }
    }
  } finally { OPENAI_PROVIDER_ADAPTER.runPrompt = original; }
});
