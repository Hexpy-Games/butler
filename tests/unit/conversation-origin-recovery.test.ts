import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { conversationMessageText } from "../../packages/butler-agent/src/agent/conversation/message-text.ts";
import { classifyConversationOrigin } from "../../packages/butler-agent/src/agent/conversation/session-admission.ts";
import { classifyHistoricalConversationOrigins } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/conversation-origin-recovery.ts";
import { subsessionResultClientMessageId } from "../../packages/butler-agent/src/gateways/app/interface/protocol/internal-result-contract.ts";
import { agentBtccStoragePaths } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/storage-ownership/index.ts";

import { initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { ingestConversationMemory } from "../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(classified: boolean) {
  const root = mkdtempSync(join(tmpdir(), "origin-recovery-")); roots.push(root);
  const descriptor = initializeEmptyMemoryGeneration(root);
  const store = new AgentConversationStore({ butlerData: root });
  const ref = `app:${subsessionResultClientMessageId("relation", "result")}`;
  const add = (session: string, turnId: string, sourceRef: string, versioned: boolean) => {
    const turn = store.beginTurn({ gateway: "app", externalSessionId: session, sessionId: session,
      actor: "user", turnId, requestId: sourceRef });
    const request = store.appendUserMessage({ sessionId: session, turnId: turn.id, text: "동일한 보고서 본문",
      sourceGateway: "app", sourceRef, originKind: "user_input", originRef: sourceRef,
      ...(versioned ? { originVersion: "conversation-origin-v1", originReason: "verified_public_ingress", originEvidence: [] } : {}) });
    const answer = store.appendAssistantMessage({ sessionId: session, turnId: turn.id, text: "사용자에게 전달된 답변",
      sourceGateway: "app", sourceRef: `${turn.id}:answer`, originKind: "assistant_public", originRef: sourceRef,
      ...(versioned ? { originVersion: "conversation-origin-v1", originReason: "verified_public_outcome", originEvidence: [] } : {}) });
    store.finalizeTurn({ turnId: turn.id, status: "complete", outcomeCapsule: { sessionId: session, turnId: turn.id,
      generation: 1, outcome: "delivered", requestMessageId: request.id, publicAssistantMessageId: answer.id } });
    return { request, answer };
  };
  const internal = add("parent", "internal-turn", ref, classified);
  const ordinary = add("parent", "ordinary-turn", "app:ordinary-user", true);
  const otherSession = add("other", "other-turn", ref, true);
  const path = agentBtccStoragePaths(root).agentBtccDbPath; mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("CREATE TABLE btcc_subsession_outbox(outbox_id TEXT,relation_id TEXT,result_id TEXT,parent_session_id TEXT,message_id TEXT)");
  db.query("INSERT INTO btcc_subsession_outbox VALUES(?,?,?,?,?)").run("outbox", "relation", "result", "parent", "subsession-result:relation:result"); db.close();
  return { root, store, descriptor, internal, ordinary, otherSession };
}

for (const classified of [false, true]) test(`exact outbox repairs ${classified ? "previously misclassified" : "unclassified"} origin without interpreting text`, () => {
  const f = fixture(classified);
  try {
    const before = f.store.readPublicSourceRevision();
    expect(classifyHistoricalConversationOrigins(f.root).applied).toBe(2);
    for (const message of [f.internal.request, f.internal.answer]) {
      const current = f.store.readMessageById(message.id)!;
      expect(current.origin_kind).toBe("internal_control");
      expect(conversationMessageText(current)).toBe(conversationMessageText(message));
    }
    expect(f.store.readTurnOutcome("internal-turn")?.outcome).toBe("delivered");
    for (const pair of [f.ordinary, f.otherSession]) {
      expect(f.store.readMessageById(pair.request.id)!.origin_kind).toBe("user_input");
      expect(f.store.readMessageById(pair.answer.id)!.origin_kind).toBe("assistant_public");
    }
    expect(f.store.readPublicSourceRevision()).toBe(before + 2);
    expect(classifyHistoricalConversationOrigins(f.root).applied).toBe(0);
    expect(f.store.readPublicSourceRevision()).toBe(before + 2);
  } finally { f.store.close(); }
});

test("existing origin replacement requires explicit internal evidence and still checks concurrent changes", () => {
  const f = fixture(true);
  try {
    const row = f.store.readOriginCandidatesPage(null, 100).find(row => row.message_id === f.internal.request.id)!;
    const decision = classifyConversationOrigin({ ref: row.source_ref, publicIngress: false, internalControl: true,
      evidenceAvailable: true, evidence: [{ kind: "subsession", ref: "outbox", sha256: "a".repeat(64) }] });
    expect(f.store.recordOriginClassification({ ...row, decision })).toBe("classification_conflict");
    expect(f.store.recordOriginClassification({ ...row, decision: { ...decision, evidence: [] }, correctInternalOrigin: true })).toBe("classification_conflict");
    expect(f.store.recordOriginClassification({ ...row, decision, correctInternalOrigin: true })).toBe("applied");
    expect(f.store.recordOriginClassification({ ...row, decision, correctInternalOrigin: true })).toBe("source_changed");
  } finally { f.store.close(); }
});


test("ingestion retires an existing public projection after authoritative origin correction", async () => {
  const f = fixture(true);
  const descriptor = f.descriptor;
  const context = { butlerData: f.root, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: AbortSignal.timeout(30000) };
  const source = { kind: "conversation_turn" as const, session_id: "parent", turn_id: "internal-turn", outcome_generation: 1 };
  const graph = new Database(join(f.root, "cognition/memory/generations", descriptor.generation_id, "graph.sqlite"));
  try {
    await ingestConversationMemory({ context, source });
    expect(graph.query<{ status:string }, []>("SELECT status FROM memory_chunks WHERE conversation_turn_id='internal-turn'").get()?.status).toBe("active");
    const originalSources = graph.query<{ source_id:string }, []>("SELECT source_id FROM memory_chunk_sources ORDER BY source_id").all();
    graph.query("INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at) VALUES('old-claim','memory_atom','internal report','user','2026-09-13')").run();
    graph.query("INSERT INTO memory_claims(node_id,statement,speech_act,basis,polarity,salience,source_class) VALUES('old-claim','internal report','assertion','user_statement','positive','normal','user')").run();
    graph.query("INSERT INTO memory_evidence(node_id,source_id,episode_id,revision) SELECT 'old-claim',source_id,episode_id,revision FROM memory_chunk_sources WHERE role='user'").run();
    classifyHistoricalConversationOrigins(f.root);
    expect((await ingestConversationMemory({ context, source })).outcome).toBe("superseded");
    expect(graph.query<{ status:string }, []>("SELECT status FROM memory_chunks WHERE conversation_turn_id='internal-turn'").get()?.status).toBe("superseded");
    expect(graph.query("SELECT source_id FROM memory_chunk_sources WHERE origin_kind!='internal_control'").all()).toHaveLength(0);
    expect(graph.query("SELECT source_id FROM memory_chunk_sources ORDER BY source_id").all()).toEqual(originalSources);
    expect(graph.query("SELECT statement,source_class FROM memory_claims WHERE node_id='old-claim'").get()).toEqual({ statement: "internal report", source_class: "unknown" });
    const revision = graph.query("SELECT value FROM memory_state WHERE key='graph_revision'").get();
    expect((await ingestConversationMemory({ context, source })).outcome).toBe("superseded");
    expect(graph.query("SELECT value FROM memory_state WHERE key='graph_revision'").get()).toEqual(revision);
  } finally { graph.close(); f.store.close(); }
});
