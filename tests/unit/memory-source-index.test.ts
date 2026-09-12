import { readGenerationHotCache } from "../../packages/butler-agent/src/agent/cognition/continuity/hot-cache-writer.ts";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { ingestConversationMemory, advanceNextMemoryProjection } from "../../packages/butler-agent/src/agent/cognition/memory/index.ts";
import { recallSourceBackedMemory } from "../../packages/butler-agent/src/agent/cognition/memory/recall/engine.ts";
import { OPENAI_PROVIDER_ADAPTER } from "../../packages/butler-agent/src/integrations/providers/openai/adapter.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "memory-source-index-"));
  const generation = initializeEmptyMemoryGeneration(root);
  const context = { butlerData: root, target: { kind: "active" as const, expected_generation: generation.generation_id }, signal: AbortSignal.timeout(30000) };
  const store = new AgentConversationStore({ butlerData: root });
  const db = new Database(join(root, "cognition/memory/generations", generation.generation_id, "graph.sqlite"));
  let ordinal = 0;
  const add = async (text: string, sessionId = "session", projectId: string | null = null, assistantText = "Received.") => {
    const turn = store.beginTurn({ gateway: "app", externalSessionId: sessionId, sessionId, projectId, actor: "user", turnId: `turn-${ordinal++}` });
    const user = store.appendUserMessage({ sessionId, turnId: turn.id, text, originKind: "user_input", originRef: `${turn.id}:user` });
    const assistant = store.appendAssistantMessage({ sessionId, turnId: turn.id, text: assistantText, originKind: "assistant_public", originRef: `${turn.id}:assistant` });
    store.finalizeTurn({ turnId: turn.id, status: "complete", outcomeCapsule: { sessionId, turnId: turn.id, generation: 1, outcome: "delivered", requestMessageId: user.id, publicAssistantMessageId: assistant.id, providerId: "test", modelRef: "test/model" } });
    const source = { kind: "conversation_turn" as const, session_id: sessionId, turn_id: turn.id, outcome_generation: 1 };
    await ingestConversationMemory({ context, source });
    return source;
  };
  const recall = (cue: string, sessionId = "session", projectId: string | null = null) => recallSourceBackedMemory({
    context, cue, includeVector: false, includeInternal: false, limit: 5,
    scope: "current_session", projectFilter: "any", projectIds: [], sessionIds: [], asOf: new Date().toISOString(),
    runtime: { sessionId, turnId: "query", currentUserMessage: cue, nativeOperationId: "query", projectId },
  });
  return { root, context, db, add, recall, close() { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("public ingestion exposes multilingual raw evidence before any meaning or binding call", async () => {
  const f = fixture();
  const original = OPENAI_PROVIDER_ADAPTER.runPrompt;
  let calls = 0;
  OPENAI_PROVIDER_ADAPTER.runPrompt = async () => { calls++; throw new Error("unexpected_provider_call"); };
  try {
    const examples = [
      ["샌디에게 캡처 기능을 추가해 주세요.", "샌디 캡처"],
      ["相機の設定を覚えてください。", "相機"],
      ["أضف التقاط الشاشة إلى ساندي", "ساندي"],
      ["Cafe\u0301 preferences are recorded here.", "CAFÉ"],
      ["猫", "猫"],
      ["Plain context. ".repeat(90) + "望遠鏡の設定を保存します。", "望遠鏡"],
    ];
    for (const [text, cue] of examples) {
      await f.add(text!);
      const result = await f.recall(cue!);
      const hit = result.results.find((item) => item.evidence.some((evidence) =>
        text!.includes(evidence.excerpt) && (text!.length < 480 || evidence.excerpt.includes(cue!)),
      ));
      expect(hit).toBeDefined();
      expect(hit!.qualifications).toContain("unclassified_source");
      expect(hit!.evidence.some((evidence) => evidence.basis === "user_statement")).toBe(true);
    }
    expect(calls).toBe(0);
    expect(f.db.query("SELECT 1 FROM memory_projection_windows WHERE state='complete'").get()).toBeNull();
    const before = f.db.query("SELECT COUNT(*) n FROM memory_source_text").get();
    const source = await f.add("Duplicate registration stays stable.");
    const once = f.db.query("SELECT COUNT(*) n FROM memory_source_text").get();
    await ingestConversationMemory({ context: f.context, source });
    expect(f.db.query("SELECT COUNT(*) n FROM memory_source_text").get()).toEqual(once);
    expect(once).not.toEqual(before);
  } finally { OPENAI_PROVIDER_ADAPTER.runPrompt = original; f.close(); }
});

test("raw retrieval finds an early conversation after more than 200 newer turns", async () => {
  const f = fixture();
  try {
    const text = "Orbit observatory maintenance notes.";
    await f.add(text);
    for (let index = 0; index < 205; index++) await f.add(`Unrelated grocery receipt ${index}.`);
    const result = await f.recall("Orbit observatory");
    expect(result.results.some((item) => item.evidence.some((evidence) => evidence.excerpt === text))).toBe(true);
    expect(f.db.query("SELECT 1 FROM memory_projection_windows WHERE state='complete'").get()).toBeNull();
  } finally { f.close(); }
}, 30000);

test("provider failure cannot remove raw recall, and source scope applies before ranking", async () => {
  const f = fixture();
  const original = OPENAI_PROVIDER_ADAPTER.runPrompt;
  let calls = 0;
  OPENAI_PROVIDER_ADAPTER.runPrompt = async () => { calls++; throw new Error("provider_unavailable"); };
  try {
    const text = "Atlas capture needs a browser.";
    await f.add(text);
    await f.add("Atlas capture secret in another session.", "private", "another-project");
    await advanceNextMemoryProjection({ context: f.context });
    expect(calls).toBeGreaterThan(0);
    const result = await f.recall("Atlas capture");
    expect(result.results.some((item) => item.evidence.some((evidence) => evidence.excerpt === text))).toBe(true);
    expect(result.results.flatMap((item) => item.evidence).every((evidence) => evidence.conversation_session_id === "session")).toBe(true);
    expect(f.db.query("SELECT 1 FROM memory_projection_windows WHERE state='complete'").get()).toBeNull();
  } finally { OPENAI_PROVIDER_ADAPTER.runPrompt = original; f.close(); }
});

test("durable A is searchable during B failure; retry links identities without merging authors", async () => {
  const f = fixture();
  const original = OPENAI_PROVIDER_ADAPTER.runPrompt;
  let failB = false;
  let meaningCalls = 0;
  OPENAI_PROVIDER_ADAPTER.runPrompt = async (request) => {
    const prompt = JSON.parse(request.prompt);
    if (prompt.parts) {
      meaningCalls++;
      const part = prompt.parts[0];
      const value = prompt.speaker === "assistant"
        ? { status: "processed", entities: [], items: [], attributes: [] }
        : { status: "processed", entities: [{ name: "Atlas", evidence: [part.id] }],
          items: [{ kind: part.text.includes("Please") ? "request" : "fact", subject: 0, text: part.text, evidence: [part.id] }], attributes: [] };
      return { text: JSON.stringify(value), model: "gpt-5.6-sol", usage: null } as never;
    }
    if (failB) throw new Error("memory_extract_provider_failed");
    return { text: JSON.stringify({ decisions: prompt.targets.map((target: any) => ({ target: target.target,
      candidate: target.candidates[0].ref, span: null, support: [...target.evidence, ...target.candidates[0].evidence] })) }), model: "gpt-5.6-sol", usage: null } as never;
  };
  try {
    await f.add("Atlas is an observatory.");
    for (let i = 0; i < 12 && f.db.query("SELECT 1 FROM memory_projection_windows WHERE state!='complete'").get(); i++) await advanceNextMemoryProjection({ context: f.context });
    expect(f.db.query("SELECT state,error_code FROM memory_projection_windows WHERE state!='complete'").all()).toEqual([]);
    const source = await f.add("Please add capture to Atlas.");
    failB = true;
    for (let i = 0; i < 12 && !f.db.query("SELECT 1 FROM memory_projection_windows WHERE error_code IS NOT NULL").get(); i++) await advanceNextMemoryProjection({ context: f.context });
    expect(f.db.query("SELECT 1 FROM memory_meaning_commits a JOIN memory_projection_windows w ON w.window_ref=a.window_ref WHERE w.state!='complete'").get()).not.toBeNull();
    const pending = await f.recall("Atlas capture");
    const claim = pending.results.flatMap((item) => item.interpretations ?? []).find((item) => item.speech_act === "request");
    expect(claim?.source_class).toBe("user");
    expect(claim?.authority).toBe("model_interpretation");
    expect(pending.results.every((item) => item.current_state_requires_verification)).toBe(true);
    const ids = f.db.query("SELECT node_id FROM memory_claims ORDER BY node_id").all();
    const before = meaningCalls;
    failB = false;
    // Advance the existing scheduler's retry time without changing its state or saved output.
    f.db.query("UPDATE memory_projection_windows SET next_attempt_at='2000-01-01' WHERE error_code IS NOT NULL").run();
    for (let i = 0; i < 12 && f.db.query("SELECT 1 FROM memory_projection_windows WHERE state!='complete'").get(); i++) await advanceNextMemoryProjection({ context: f.context });
    expect(f.db.query("SELECT state,error_code FROM memory_projection_windows WHERE state!='complete'").all()).toEqual([]);
    expect(meaningCalls - before).toBeLessThanOrEqual(1); // Only the still-unprocessed assistant window.
    expect(f.db.query("SELECT node_id FROM memory_claims ORDER BY node_id").all()).toEqual(ids);
    expect(f.db.query("SELECT 1 FROM edges WHERE rel_type='identity_match'").get()).not.toBeNull();
    expect(f.db.query("SELECT 1 FROM memory_nodes WHERE canonical_node_id IS NOT NULL").get()).toBeNull();
    const mentions = f.db.query<{ text: string; surface: string; byte_start: number; byte_end: number }, []>("SELECT t.text,m.surface,m.byte_start,m.byte_end FROM memory_mentions m JOIN memory_source_text t ON t.source_id=m.source_id WHERE m.method='literal'").all();
    expect(mentions.length).toBeGreaterThan(0);
    expect(mentions.every((m) => Buffer.from(m.text).subarray(m.byte_start, m.byte_end).toString() === m.surface)).toBe(true);
    // Expired interpretations do not make the original request disappear.
    f.db.query("UPDATE memory_claims SET valid_to='2000-01-01' WHERE speech_act='request'").run();
    f.db.query("UPDATE memory_state SET value=CAST(value AS INTEGER)+1 WHERE key='graph_revision'").run();
    const historical = await f.recall("Atlas capture");
    expect(historical.results.some((item) => item.evidence.some((e) => e.excerpt.includes("Please add capture")))).toBe(true);
    expect(historical.results.flatMap((item) => item.interpretations ?? []).some((item) => item.status === "historical")).toBe(true);
    // Canonical exclusion, not an interpretation, determines whether source is retrievable.
    f.db.query("UPDATE memory_chunks SET status='excluded' WHERE conversation_turn_id=?").run(source.turn_id);
    f.db.query("UPDATE memory_state SET value=CAST(value AS INTEGER)+1 WHERE key='graph_revision'").run();
    expect((await f.recall("Atlas capture")).results.every((item) => item.evidence.every((e) => !e.excerpt.includes("Please add capture")))).toBe(true);
  } finally { OPENAI_PROVIDER_ADAPTER.runPrompt = original; f.close(); }
}, 20000);

test("even a model misclassification keeps user and assistant claims separate in recall and hot cache", async () => {
  const f = fixture();
  const original = OPENAI_PROVIDER_ADAPTER.runPrompt;
  OPENAI_PROVIDER_ADAPTER.runPrompt = async (request) => {
    const prompt = JSON.parse(request.prompt);
    // Deliberately wrong meaning: a request and a report both become the same asserted fact.
    return { text: JSON.stringify({ status: "processed", entities: [],
      items: [{ kind: "fact", subject: null, text: "Atlas capture is enabled.", evidence: [prompt.parts[0].id] }], attributes: [] }), model: "gpt-5.6-sol", usage: null } as never;
  };
  try {
    const source = await f.add("Please enable Atlas capture.", "session", null, "Atlas capture is enabled.");
    for (let i = 0; i < 12 && f.db.query("SELECT 1 FROM memory_projection_windows WHERE state!='complete'").get(); i++) await advanceNextMemoryProjection({ context: f.context });
    expect(f.db.query("SELECT state,error_code FROM memory_projection_windows WHERE state!='complete'").all()).toEqual([]);
    const claims = f.db.query<{ node_id: string; source_class: string; authority: string }, []>("SELECT node_id,source_class,authority FROM memory_claims ORDER BY source_class").all();
    expect(claims.map((c) => c.source_class)).toEqual(["assistant", "user"]);
    expect(new Set(claims.map((c) => c.node_id)).size).toBe(2);
    expect(claims.every((c) => c.authority === "model_interpretation")).toBe(true);
    const recall = await f.recall("Atlas capture");
    expect(new Set(recall.results.flatMap((r) => r.interpretations ?? []).map((c) => c.source_class))).toEqual(new Set(["user", "assistant"]));
    // Let the production scheduler write the real cache, then read through its validator.
    for (let i = 0; i < 12 && f.db.query("SELECT 1 FROM memory_projection_jobs WHERE json_extract(hot_cache_state,'$.state')!='complete'").get(); i++) await advanceNextMemoryProjection({ context: f.context });
    const cache = readGenerationHotCache({ butlerData: f.root });
    expect(cache).toContain("model_interpretation/user");
    expect(cache).toContain("model_interpretation/assistant");
    expect(cache).toContain("current_state_requires_verification");
    f.db.query("UPDATE memory_chunks SET status='excluded' WHERE conversation_turn_id=?").run(source.turn_id);
    expect(readGenerationHotCache({ butlerData: f.root })).toBeNull();
  } finally { OPENAI_PROVIDER_ADAPTER.runPrompt = original; f.close(); }
}, 20000);
