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
  const add = async (text: string, sessionId = "session", projectId: string | null = null) => {
    const turn = store.beginTurn({ gateway: "app", externalSessionId: sessionId, sessionId, projectId, actor: "user", turnId: `turn-${ordinal++}` });
    const user = store.appendUserMessage({ sessionId, turnId: turn.id, text, originKind: "user_input", originRef: `${turn.id}:user` });
    const assistant = store.appendAssistantMessage({ sessionId, turnId: turn.id, text: "Received.", originKind: "assistant_public", originRef: `${turn.id}:assistant` });
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
  return { context, db, add, recall, close() { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
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
