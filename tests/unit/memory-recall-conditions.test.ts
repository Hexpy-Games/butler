import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { projectionHash } from "../../packages/butler-agent/src/agent/cognition/memory/projection/source.ts";
import { installAndBackfillRecallIndexes } from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";
import { recallSourceBackedMemory } from "../../packages/butler-agent/src/agent/cognition/memory/recall/engine.ts";
import { diversifyBySession } from "../../packages/butler-agent/src/agent/cognition/memory/recall/ranking.ts";

test("session diversity only breaks relevance ties", () => {
  const values = [
    { episodeId: "first", sessionId: "same", score: 0.9, conversationAt: null, channels: [] },
    { episodeId: "relevant", sessionId: "same", score: 0.8, conversationAt: null, channels: [] },
    { episodeId: "tie", sessionId: "other", score: 0.8, conversationAt: null, channels: [] },
    { episodeId: "weak", sessionId: "third", score: 0.2, conversationAt: null, channels: [] },
  ];
  expect(diversifyBySession(values, 4).map((value) => value.episodeId)).toEqual(["first", "tie", "relevant", "weak"]);
});

test("DB-backed graph traverses condition_member and separates two systems with the same feature name", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-conditions-"));
  const descriptor = initializeEmptyMemoryGeneration(root);
  const db = new Database(join(root, "cognition/memory/generations", descriptor.generation_id, "graph.sqlite"));
  const canonical = new AgentConversationStore({ butlerData: root });
  const observed = "2026-09-01T00:00:00Z";
  try {
    for (const [system, gate] of [["Atlas", "東京鍵"], ["Boreal", "مفتاح"]]) {
      for (const kind of ["gate", "rule"]) {
        const id = `${system}-${kind}`;
        const text = kind === "gate" ? gate! : `${system} capture requires ${gate}.`;
        canonical.beginTurn({ gateway: "app", externalSessionId: id, sessionId: id, turnId: id, actor: "user", now: observed });
        const message = canonical.appendUserMessage({ sessionId: id, turnId: id, text, originKind: "user_input", now: observed });
        canonical.finalizeTurn({ turnId: id, status: "complete", completedAt: observed, outcomeCapsule: { sessionId: id, turnId: id, generation: 1, outcome: "delivered", requestMessageId: message.id } });
        const hash = createHash("sha256").update(text).digest("hex");
        const episode = projectionHash(["canonical-conversation-turn", id]);
        const revision = projectionHash(["episode-revision", message.id, message.parts[0]!.id, "/text", hash, 1]);
        db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,origin_kind,status,summary,source_hash,created_at,updated_at) VALUES(?,?,?,?,?,'user_input','active',?,?,?,?)")
          .run(episode, episode, revision, id, id, text, hash, observed, observed);
        db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES(?,?,?,'conversation',?,?,?,'/text',0,?,?,'user','user_input',?,'user_statement')")
          .run(id, episode, revision, id, message.id, message.parts[0]!.id, Buffer.byteLength(text), hash, observed);
        const properties = kind === "rule" ? { statement: text, speech_act: "assertion", basis: "user_statement", requirement: { action: "capture", condition: { subject: `${system}-gate`, state: "enabled" } } } : {};
        db.query("INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at) VALUES(?,?,?,'user',?)")
          .run(id, kind === "rule" ? "constraint" : "entity", kind === "rule" ? "capture" : gate, observed);
        if (kind === "rule") db.query("INSERT INTO memory_claims(node_id,statement,speech_act,basis,polarity,requirement,salience,source_class) VALUES(?,?,'assertion','user_statement','positive',?,'normal','user')").run(id, text, JSON.stringify(properties.requirement));
        db.query("INSERT INTO memory_evidence(node_id,source_id,episode_id,revision) VALUES(?,?,?,?)").run(id, id, episode, revision);
        // Only the introduction owns the exact alias. Finding the rule requires
        // traversing its stored condition edge, not co-occurrence in one source.
        if (kind === "gate") db.query("INSERT INTO memory_aliases(node_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,?,?,?,?,'create')")
          .run(id, gate, gate, gate, id);
      }
      db.query("INSERT INTO edges(edge_id,source_node_id,target_node_id,rel_type,claim_node_id,status) VALUES(?,?,?,'condition_member',?,'active')")
        .run(system, `${system}-rule`, `${system}-gate`, `${system}-rule`);
      db.query("INSERT INTO edge_evidence(edge_id,chunk_source_id,basis,extraction_version) VALUES(?,?,'user_statement','v3')").run(system, `${system}-rule`);
    }
    installAndBackfillRecallIndexes(db);
    for (const [system, cue] of [["Atlas", "東京鍵"], ["Boreal", "مفتاح"]]) {
      const result = await recallSourceBackedMemory({
        context: { butlerData: root, target: { kind: "active", expected_generation: descriptor.generation_id }, signal: new AbortController().signal },
        cue: cue!, includeVector: false, includeInternal: false, limit: 5, scope: "all_user_sessions", projectFilter: "any", projectIds: [], sessionIds: [], asOf: "2026-09-12T00:00:00Z",
        admittedChannels: { graph: true, lexical: false, vector: false, context: false, explicit: false, task: false },
        runtime: { sessionId: "query", turnId: "query", currentUserMessage: cue!, nativeOperationId: "query", projectId: null },
      });
      const rules = result.results.filter((item) => item.requirements?.length);
      expect(rules).toHaveLength(1);
      expect(rules[0]!.summary).toBe(`${system} capture requires ${cue}.`);
      expect(rules[0]!.association_path).toEqual([{ from: `${system}-rule`, relation: "condition_member", to: `${system}-gate`, traversed_reverse: true }]);
      expect(rules[0]!.requirements![0]!.condition).toEqual({ subject: `${system}-gate`, state: "enabled" });
      expect(rules[0]!.evidence[0]!.basis).toBe("user_statement");
    }
  } finally { canonical.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
