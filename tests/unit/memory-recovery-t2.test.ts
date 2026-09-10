import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandGraph } from "../../packages/butler-agent/src/agent/cognition/memory/recall/graph.ts";
import { rankEpisodes } from "../../packages/butler-agent/src/agent/cognition/memory/recall/ranking.ts";
import { installAndBackfillRecallIndexes, ensureV2MemorySchema, refreshVectorUnitsForJob } from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";
import { selectSemanticSeeds, selectTemporalSeeds } from "../../packages/butler-agent/src/agent/cognition/memory/recall/candidates.ts";
import { createRecallMemoryToolHandler } from "../../packages/butler-agent/src/agent/tools/memory/recall_memory/executor.ts";
import { AgentConversationStore, conversationStorePath } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { bindObservedGenerationEmbeddingUnderWriteGate, initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { recallSourceBackedMemory } from "../../packages/butler-agent/src/agent/cognition/memory/recall/engine.ts";
import { projectionHash } from "../../packages/butler-agent/src/agent/cognition/memory/projection/source.ts";
import { filterCurrentGenerationVectorMatches } from "../../packages/butler-agent/src/agent/cognition/memory/recall/vector.ts";
import { readOperationalMetricEvents } from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import { assertAllocatedProjectionState } from "../e2e/memory-recovery-multilingual-live-e2e.ts";

test("legacy allocation guard admits known columns and rejects newly split children", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-memory-legacy-guard-"));
  const graphPath = join(root, "legacy.sqlite");
  try {
    const db = new Database(graphPath);
    db.exec(`
      CREATE TABLE memory_projection_jobs(job_id TEXT PRIMARY KEY);
      CREATE TABLE memory_projection_windows(
        window_ref TEXT PRIMARY KEY,job_id TEXT NOT NULL,state TEXT NOT NULL,error_code TEXT,
        source_refs_json TEXT,normalized_plan_json TEXT,output_json TEXT,provider_evidence_json TEXT
      );
      INSERT INTO memory_projection_jobs VALUES('j1'),('j2'),('j3');
      INSERT INTO memory_projection_windows VALUES
        ('w1','j1','complete',NULL,'[]','{"plan":1}','{"output":1}','{"provider":1}'),
        ('w2','j2','complete',NULL,'[]','{"plan":2}','{"output":2}','{"provider":2}'),
        ('w3','j3','failed','memory_extract_invalid_quote','[]',NULL,'{"failed":1}','{"provider":3}');
    `);
    db.close();
    expect(assertAllocatedProjectionState(graphPath, 3, "w3")).toMatchObject({ jobs: 3, windows: 3, split_children: 0, complete: 2, failed: 1 });
    const migrated = new Database(graphPath);
    migrated.exec("ALTER TABLE memory_projection_windows ADD COLUMN parent_window_ref TEXT; ALTER TABLE memory_projection_windows ADD COLUMN next_attempt_at TEXT");
    migrated.query("INSERT INTO memory_projection_windows(window_ref,job_id,state,error_code,parent_window_ref) VALUES('child','j3','pending',NULL,'w3')").run();
    migrated.close();
    expect(() => assertAllocatedProjectionState(graphPath, 3, "w3")).toThrow("memory projection exceeded allocated source windows");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("query-specific graph expansion preserves stored edge direction on reverse traversal", () => {
  const edges = [
    { edgeId: "e-claim", sourceNodeId: "claim", targetNodeId: "cat", relation: "has_subject", claimNodeId: "claim", support: 2 },
    { edgeId: "e-toy", sourceNodeId: "claim", targetNodeId: "ball", relation: "has_object", claimNodeId: "claim", support: 2 },
  ];
  const graph = expandGraph(
    ["cat"],
    (nodeId) => ({ edges: edges.filter((edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId), truncated: false }),
    Date.now() + 1_000,
  );
  expect(graph.paths.get("claim")).toEqual([
    { from: "claim", relation: "has_subject", to: "cat", traversed_reverse: true },
  ]);
  expect(graph.paths.get("ball")?.at(-1)).toEqual({
    from: "claim", relation: "has_object", to: "ball", traversed_reverse: false,
  });
});

test("graph expansion retains hub adjacency, serves seeds fairly, and replaces a longer path", () => {
  const hubEdges = Array.from({ length: 300 }, (_, index) => ({
    edgeId: `hub-${String(index).padStart(3, "0")}`,
    sourceNodeId: "hub",
    targetNodeId: `n-${String(index).padStart(3, "0")}`,
    relation: "related_to",
    claimNodeId: null,
    support: index === 299 ? 1 : 2,
  }));
  const slowEdges = [
    { edgeId: "slow-1", sourceNodeId: "slow", targetNodeId: "a", relation: "related_to", claimNodeId: null, support: 2 },
    { edgeId: "slow-2", sourceNodeId: "a", targetNodeId: "b", relation: "related_to", claimNodeId: null, support: 2 },
    { edgeId: "slow-3", sourceNodeId: "b", targetNodeId: "n-299", relation: "related_to", claimNodeId: null, support: 2 },
    { edgeId: "fair", sourceNodeId: "other", targetNodeId: "other-result", relation: "related_to", claimNodeId: null, support: 2 },
  ];
  const all = [...hubEdges, ...slowEdges];
  const graph = expandGraph(["slow", "hub", "other"], (nodeId, limit, offset) => {
    const adjacent = all.filter((edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId);
    return { edges: adjacent.slice(offset, offset + limit), truncated: offset + limit < adjacent.length };
  }, Date.now() + 5_000);
  expect(graph.paths.has("n-100")).toBe(true);
  expect(graph.paths.has("other-result")).toBe(true);
  expect(graph.paths.get("n-299")).toEqual([
    { from: "hub", relation: "related_to", to: "n-299", traversed_reverse: false },
  ]);
});

test("same-seed equal-length graph paths adopt the binary-smaller edge sequence", () => {
  const edges = [
    { edgeId: "z-first", sourceNodeId: "seed", targetNodeId: "a", relation: "related_to", claimNodeId: null, support: 2 },
    { edgeId: "a-first", sourceNodeId: "seed", targetNodeId: "b", relation: "related_to", claimNodeId: null, support: 2 },
    { edgeId: "z-tail", sourceNodeId: "a", targetNodeId: "target", relation: "related_to", claimNodeId: null, support: 2 },
    { edgeId: "a-tail", sourceNodeId: "b", targetNodeId: "target", relation: "related_to", claimNodeId: null, support: 2 },
  ];
  const graph = expandGraph(["seed"], (nodeId) => ({
    edges: edges.filter((edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId),
    truncated: false,
  }), Date.now() + 1_000);
  expect(graph.paths.get("target")).toEqual([
    { from: "seed", relation: "related_to", to: "b", traversed_reverse: false },
    { from: "b", relation: "related_to", to: "target", traversed_reverse: false },
  ]);
});

test("episode fusion uses one successful-channel denominator", () => {
  const ranked = rankEpisodes([
    { episodeId: "hybrid", sessionId: "s1", conversationAt: null, graphRank: 1, lexicalRank: 1, vectorRank: 1 },
    { episodeId: "graph", sessionId: "s2", conversationAt: null, graphRank: 1 },
  ], { graph: true, vector: true, lexical: true, context: false }, "2026-09-09T00:00:00Z");
  expect(ranked[0]!.episodeId).toBe("hybrid");
  expect(ranked.find((item) => item.episodeId === "graph")!.score).toBeCloseTo(0.32, 8);
});

test("T2 install backfills Unicode grapheme postings and scoped lexical seeds", () => {
  const db = new Database(":memory:");
  ensureV2MemorySchema(db);
  db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,project_id,origin_kind,status,source_hash,created_at,updated_at) VALUES('ep','source','r1','s',NULL,'user_input','active','h','2026-09-08T00:00:00Z','2026-09-08T00:00:00Z')").run();
  db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES('src','ep','r1','conversation','s','m','p','/text',0,9,'h','user','user_input','2026-09-08T00:00:00Z','user_statement')").run();
  db.query("INSERT INTO entities(id,type,label_original,identity_scope,created_at) VALUES('n','entity','별무리','user','2026-09-08T00:00:00Z')").run();
  db.query("INSERT INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES('n','별무리','별무리','별무리','src','create')").run();
  installAndBackfillRecallIndexes(db);
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) count FROM entity_alias_postings WHERE entity_id='n'").get()!.count).toBeGreaterThan(0);
  const selected = selectSemanticSeeds(db, {
    context: { butlerData: process.env.BUTLER_DATA!, target: { kind: "rebuild", generation_id: "x", canonical_snapshot_id: "x" }, signal: new AbortController().signal },
    cue: "무리", includeVector: false, includeInternal: false, limit: 6, scope: "all_user_sessions", projectFilter: "unassigned", projectIds: [], sessionIds: [], asOf: "2026-09-09T00:00:00Z",
    runtime: { sessionId: "s", turnId: "t", currentUserMessage: "무리", nativeOperationId: "op", projectId: null },
  });
  expect(selected.seeds).toContain("n");
  db.query("INSERT INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES('n','별 무리','별 무리','별 무리','src','create')").run();
  installAndBackfillRecallIndexes(db);
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) count FROM entity_alias_postings WHERE entity_id='n' AND surface_original='별 무리'").get()!.count).toBeGreaterThan(0);
  db.close();
});

test("lexical scoring uses unsquared IDF sums and UTC-equivalent source instants", () => {
  const db = new Database(":memory:");
  ensureV2MemorySchema(db);
  const surfaces = ["abc", "abx", "aby", "abz"];
  for (const [index, surface] of surfaces.entries()) {
    const observed = index === 0 ? "2026-09-08T09:00:00+09:00" : "2026-09-07T00:00:00Z";
    db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,project_id,origin_kind,status,source_hash,created_at,updated_at) VALUES(?,?,'r1','s',NULL,'user_input','active','h',?,?)")
      .run(`ep-${index}`, `source-${index}`, observed, observed);
    db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES(?,?,'r1','conversation','s',?,?,'/text',0,1,'h','user','user_input',?,'user_statement')")
      .run(`src-${index}`, `ep-${index}`, `message-${index}`, `part-${index}`, observed);
    db.query("INSERT INTO entities(id,type,label_original,identity_scope,created_at) VALUES(?,'entity',?,'user','2026-09-07T00:00:00Z')").run(`node-${index}`, surface);
    db.query("INSERT INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,?,?,?,?,'create')")
      .run(`node-${index}`, surface, surface, surface, `src-${index}`);
  }
  installAndBackfillRecallIndexes(db);
  const selected = selectSemanticSeeds(db, recallInput({ cue: "abcd", asOf: "2026-09-08T00:00:00Z" }));
  const n = 4;
  const weight = (df: number) => Math.log(1 + (n + 1) / (df + 1));
  const expected = (weight(4) + weight(1) + weight(1)) /
    Math.sqrt((weight(4) + weight(1) + weight(0) + weight(1) + weight(0)) *
      (weight(4) + weight(1) + weight(1)));
  expect(selected.scores.get("node-0")?.get("lexical")).toBeCloseTo(expected, 10);
  expect(selected.seeds).toContain("node-0");
  db.close();
});

test("conversation-time selection caps each bin and rotates sessions", () => {
  const db = new Database(":memory:");
  ensureV2MemorySchema(db);
  for (let index = 0; index < 9; index += 1) {
    const episode = `ep-${index}`;
    const session = `session-${index % 3}`;
    const observed = `2026-09-08T12:${String(index).padStart(2, "0")}:00Z`;
    db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,project_id,origin_kind,status,source_hash,created_at,updated_at) VALUES(?,?, 'r1',?,NULL,'user_input','active','h',?,?)")
      .run(episode, episode, session, observed, observed);
    db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES(?,?,'r1','conversation',?,?,?,'/text',0,1,'h','user','user_input',?,'user_statement')")
      .run(`src-${index}`, episode, session, `message-${index}`, `part-${index}`, observed);
  }
  const selected = selectTemporalSeeds(db, {
    context: { butlerData: process.env.BUTLER_DATA!, target: { kind: "rebuild", generation_id: "x", canonical_snapshot_id: "x" }, signal: new AbortController().signal },
    cue: "when", includeVector: false, includeInternal: false, limit: 6, scope: "all_user_sessions", projectFilter: "unassigned", projectIds: [], sessionIds: [], asOf: "2026-09-09T00:00:00Z",
    time: { from: "2026-09-08T00:00:00Z", to: "2026-09-09T00:00:00Z", basis: "conversation" },
    runtime: { sessionId: "query", turnId: "turn", currentUserMessage: "when", nativeOperationId: "op", projectId: null },
  });
  expect(selected.episodeIds).toHaveLength(8);
  expect(new Set(selected.episodeIds.slice(0, 3).map((id) => Number(id.split("-")[1]) % 3)).size).toBe(3);
  db.close();
});

test("source hydration rejects a changed companion scalar and refills from the next ranked episode", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t2-refill-"));
  try {
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const context = { butlerData, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: new AbortController().signal };
    bindObservedGenerationEmbeddingUnderWriteGate(context, {
      model: "test/model", dimension: 2, pooling: "cls", normalize: true, version: "1".repeat(64), max_tokens: 8,
      transformers_version: "test", node_runtime_version: process.versions.node, bun_runtime_version: process.versions.bun ?? null,
      tokenizer_asset_sha256: "2".repeat(64), model_asset_sha256: "3".repeat(64),
    });
    const canonical = new AgentConversationStore({ butlerData });
    const messages: Array<{ id: string; partId: string; text: string; turnId: string; episodeId: string; revision: string }> = [];
    try {
      for (const [index, text] of ["changed source", "valid source"].entries()) {
        const sessionId = `source-session-${index}`;
        const turnId = `source-turn-${index}`;
        canonical.beginTurn({ gateway: "app", externalSessionId: sessionId, sessionId, actor: "user", turnId });
        const message = canonical.appendUserMessage({ sessionId, turnId, text, originKind: "user_input", originRef: `test:${index}` });
        const assistant = index === 0
          ? canonical.appendAssistantMessage({ sessionId, turnId, text: "new companion scalar", originKind: "assistant_public", originRef: "test:assistant" })
          : null;
        canonical.finalizeTurn({ turnId, status: "complete", outcomeCapsule: {
          sessionId, turnId, generation: 1, outcome: "delivered", requestMessageId: message.id,
          ...(assistant ? { publicAssistantMessageId: assistant.id } : {}),
        } });
        const hash = createHash("sha256").update(text).digest("hex");
        messages.push({
          id: message.id,
          partId: message.parts[0]!.id,
          text,
          turnId,
          episodeId: projectionHash(["canonical-conversation-turn", turnId]),
          revision: projectionHash(["episode-revision", message.id, message.parts[0]!.id, "/text", hash, 1]),
        });
      }
    } finally { canonical.close(); }
    const graphPath = join(butlerData, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite");
    const db = new Database(graphPath);
    try {
      for (const [index, message] of messages.entries()) {
        const episode = message.episodeId;
        const node = index === 0 ? "a-node" : "b-node";
        const source = index === 0 ? "a-source" : "b-source";
        db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,project_id,origin_kind,status,summary,summary_status,source_hash,created_at,updated_at) VALUES(?,?,?,?,?,NULL,'user_input','active',?,'complete','h','2026-09-08T00:00:00Z','2026-09-08T00:00:00Z')")
          .run(episode, episode, message.revision, `source-session-${index}`, message.turnId, message.text);
        const hash = createHash("sha256").update(message.text).digest("hex");
        db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES(?,?,?,'conversation',?,?,?,'/text',0,?,?, 'user','user_input','2026-09-08T00:00:00Z','user_statement')")
          .run(source, episode, message.revision, `source-session-${index}`, message.id, message.partId, Buffer.byteLength(message.text), hash);
        db.query("INSERT INTO entities(id,type,label_original,identity_scope,created_at) VALUES(?,'entity','needle','user','2026-09-08T00:00:00Z')").run(node);
        db.query("INSERT INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,'needle','needle','needle',?,'create')").run(node, source);
        db.query("INSERT INTO entity_mentions(entity_id,source_id,episode_id,revision) VALUES(?,?,?,?)").run(node, source, episode, message.revision);
      }
      installAndBackfillRecallIndexes(db);
    } finally { db.close(); }
    const recalled = await recallSourceBackedMemory({
      context,
      cue: "needle", includeVector: false, includeInternal: false, limit: 1, scope: "all_user_sessions", projectFilter: "unassigned", projectIds: [], sessionIds: [], asOf: "2026-09-09T00:00:00Z",
      runtime: { sessionId: "query-session", turnId: "query-turn", currentUserMessage: "needle", nativeOperationId: "query-operation", projectId: null },
    });
    expect(recalled.status).toBe("partial");
    expect(recalled.coverage.vectors.state).toBe("disabled_by_request");
    expect(recalled.coverage.source.codes).toContain("source_resolution_failed");
    expect(recalled.results).toHaveLength(1);
    expect(recalled.results[0]!.episode_ref).toBe(messages[1]!.episodeId);
    expect(recalled.results[0]!.matched_node_ref).toBe("b-node");
    expect(recalled.results[0]!.association_path).toEqual([]);
    expect(recalled.results[0]!.evidence[0]!.excerpt).toBe("valid source");
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

test("native v2 recall fails closed when current message or operation binding is absent", async () => {
  const handler = createRecallMemoryToolHandler({ butlerHome: "/isolated", butlerData: "/isolated", sessionId: "s", turnId: "t" });
  const call = { name: "recall_memory", args: { cue: "memory", include_vector: false }, rawArguments: "{}", toolContractVersion: 2 } as const;
  await expect(handler(call)).rejects.toThrow("runtime session and turn binding");
  const bound = createRecallMemoryToolHandler({ butlerHome: "/isolated", butlerData: "/isolated", sessionId: "s", turnId: "t", currentUserMessage: "memory" });
  await expect(bound(call)).rejects.toThrow("runtime session and turn binding");
});

test("canonical inventory marks an unregistered terminal episode as ingestion pending", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t2-pending-"));
  try {
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const canonical = new AgentConversationStore({ butlerData });
    try {
      canonical.beginTurn({ gateway: "app", externalSessionId: "source", sessionId: "source", actor: "user", turnId: "turn" });
      const message = canonical.appendUserMessage({ sessionId: "source", turnId: "turn", text: "not projected", originKind: "user_input" });
      canonical.finalizeTurn({ turnId: "turn", status: "complete", outcomeCapsule: { sessionId: "source", turnId: "turn", generation: 1, outcome: "delivered", requestMessageId: message.id } });
    } finally { canonical.close(); }
    const recalled = await recallSourceBackedMemory({
      ...recallInput({ cue: "absent", asOf: new Date(Date.now() + 1_000).toISOString() }),
      context: { butlerData, target: { kind: "active", expected_generation: descriptor.generation_id }, signal: new AbortController().signal },
    });
    expect(recalled.status).toBe("unavailable");
    expect(recalled.coverage.graph.codes).toContain("ingestion_pending");
    expect(recalled.coverage.source.codes).toContain("ingestion_pending");
    expect(recalled.results).toEqual([]);
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

test("readonly recall reports missing canonical storage without creating it", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t2-readonly-"));
  try {
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const canonicalPath = conversationStorePath(butlerData);
    rmSync(canonicalPath, { force: true });
    expect(existsSync(canonicalPath)).toBe(false);
    const recalled = await recallSourceBackedMemory({
      ...recallInput({ cue: "absent" }),
      context: { butlerData, target: { kind: "active", expected_generation: descriptor.generation_id }, signal: new AbortController().signal },
    });
    expect(recalled.status).toBe("unavailable");
    expect(recalled.coverage.graph.codes).toContain("ingestion_inventory_partial");
    expect(existsSync(canonicalPath)).toBe(false);
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

test("native scope validation fails closed without creating canonical storage", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t2-native-readonly-"));
  try {
    initializeEmptyMemoryGeneration(butlerData);
    const canonicalPath = conversationStorePath(butlerData);
    rmSync(canonicalPath, { force: true });
    const handler = createRecallMemoryToolHandler({ butlerHome: butlerData, butlerData, sessionId: "session", turnId: "turn", currentUserMessage: "memory" });
    const call = { name: "recall_memory", args: { cue: "memory", include_vector: false }, rawArguments: "{}", toolContractVersion: 2 } as const;
    await expect(handler(call, { effectOccurrenceId: "operation" })).rejects.toThrow("backend_unavailable");
    expect(existsSync(canonicalPath)).toBe(false);
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

test("stored supersedes relationships remove the old claim and prioritize the current correction", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t2-correction-"));
  try {
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const canonical = new AgentConversationStore({ butlerData });
    const episodes: Array<{ episodeId: string; revision: string; turnId: string; messageId: string; partId: string; text: string }> = [];
    try {
      for (const [index, text] of ["old preference", "corrected preference"].entries()) {
        const turnId = `turn-${index}`;
        canonical.beginTurn({ gateway: "app", externalSessionId: `session-${index}`, sessionId: `session-${index}`, actor: "user", turnId });
        const message = canonical.appendUserMessage({ sessionId: `session-${index}`, turnId, text, originKind: "user_input" });
        canonical.finalizeTurn({ turnId, status: "complete", outcomeCapsule: { sessionId: `session-${index}`, turnId, generation: 1, outcome: "delivered", requestMessageId: message.id } });
        const hash = createHash("sha256").update(text).digest("hex");
        episodes.push({
          episodeId: projectionHash(["canonical-conversation-turn", turnId]),
          revision: projectionHash(["episode-revision", message.id, message.parts[0]!.id, "/text", hash, 1]),
          turnId, messageId: message.id, partId: message.parts[0]!.id, text,
        });
      }
    } finally { canonical.close(); }
    const db = new Database(join(butlerData, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite"));
    try {
      for (const [index, episode] of episodes.entries()) {
        const sourceId = `source-${index}`;
        const nodeId = index === 0 ? "old-claim" : "new-claim";
        db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,project_id,origin_kind,status,summary,summary_status,source_hash,created_at,updated_at) VALUES(?,?,?,?,?,NULL,'user_input','active',?,'complete','h','2026-09-08T00:00:00Z','2026-09-08T00:00:00Z')")
          .run(episode.episodeId, episode.episodeId, episode.revision, `session-${index}`, episode.turnId, episode.text);
        db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES(?,?,?,'conversation',?,?,?,'/text',0,?,?,'user','user_input','2026-09-08T00:00:00Z','user_statement')")
          .run(sourceId, episode.episodeId, episode.revision, `session-${index}`, episode.messageId, episode.partId, Buffer.byteLength(episode.text), createHash("sha256").update(episode.text).digest("hex"));
        db.query("INSERT INTO entities(id,type,label_original,properties,identity_scope,created_at) VALUES(?,'memory_atom',?,?,'user','2026-09-08T00:00:00Z')")
          .run(nodeId, episode.text, JSON.stringify({ statement: episode.text, valid_from: "2026-09-08T00:00:00Z", salience: "normal" }));
        db.query("INSERT INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,'preference','preference','preference',?,'create')").run(nodeId, sourceId);
        db.query("INSERT INTO entity_mentions(entity_id,source_id,episode_id,revision) VALUES(?,?,?,?)").run(nodeId, sourceId, episode.episodeId, episode.revision);
      }
      db.query("INSERT INTO edges(edge_id,source_node_id,target_node_id,rel_type,valid_from,status) VALUES('correction','new-claim','old-claim','supersedes','2026-09-08T00:00:00Z','active')").run();
      db.query("INSERT INTO edge_evidence(edge_id,chunk_source_id,basis,extraction_version) VALUES('correction','source-1','user_statement','v')").run();
      installAndBackfillRecallIndexes(db);
    } finally { db.close(); }
    const recalled = await recallSourceBackedMemory({
      ...recallInput({ cue: "preference" }),
      context: { butlerData, target: { kind: "active", expected_generation: descriptor.generation_id }, signal: new AbortController().signal },
    });
    expect(recalled.results.map((result) => result.episode_ref)).toEqual([episodes[1]!.episodeId]);
    expect(Buffer.from(recalled.results[0]!.evidence[0]!.source_ref.split(":")[3]!, "base64url").toString("utf8")).toBe("source-1");
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

test("fixed as-of validity excludes expired and future claims while preserving past history and typed rule priority", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t2-validity-"));
  try {
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const definitions = [
      { id: "valid", text: "valid fact", observed: "2026-09-01T10:00:00Z", type: "memory_atom", aliases: ["valid"], properties: { statement: "valid fact", valid_from: "2026-09-01T00:00:00Z", valid_to: "2026-09-10T00:00:00Z" } },
      { id: "expired", text: "expired fact", observed: "2026-09-01T11:00:00Z", type: "memory_atom", aliases: ["expired"], properties: { statement: "expired fact", valid_from: "2026-09-01T00:00:00Z", valid_to: "2026-09-05T00:00:00Z" } },
      { id: "future", text: "future fact", observed: "2026-09-01T12:00:00Z", type: "memory_atom", aliases: ["future"], properties: { statement: "future fact", valid_from: "2026-09-09T00:00:00Z" } },
      { id: "weak", text: "priority weak inference", observed: "2026-09-02T10:00:00Z", type: "memory_atom", aliases: ["priority"], properties: { statement: "priority weak inference", valid_from: "2026-09-01T00:00:00Z", salience: "high" } },
      { id: "rule", text: "priority rule when tired", observed: "2026-09-02T11:00:00Z", type: "constraint", aliases: ["priority"], properties: { statement: "priority rule when tired", valid_from: "2026-09-01T00:00:00Z", speech_act: "assertion", basis: "user_statement", condition: "when tired" } },
      { id: "correction", text: "corrected historical fact", observed: "2026-09-06T10:00:00Z", type: "memory_atom", aliases: ["corrected"], properties: { statement: "corrected historical fact", valid_from: "2026-09-06T10:00:00Z" } },
    ] as const;
    const canonical = new AgentConversationStore({ butlerData });
    const rows: Array<typeof definitions[number] & { episodeId: string; revision: string; messageId: string; partId: string; turnId: string }> = [];
    try {
      for (const definition of definitions) {
        const turnId = `turn-${definition.id}`, sessionId = `session-${definition.id}`;
        canonical.beginTurn({ gateway: "app", externalSessionId: sessionId, sessionId, actor: "user", turnId, now: definition.observed });
        const message = canonical.appendUserMessage({ sessionId, turnId, text: definition.text, originKind: "user_input", now: definition.observed });
        canonical.finalizeTurn({ turnId, status: "complete", completedAt: definition.observed, outcomeCapsule: { sessionId, turnId, generation: 1, outcome: "delivered", requestMessageId: message.id } });
        const contentHash = createHash("sha256").update(definition.text).digest("hex");
        rows.push({ ...definition, episodeId: projectionHash(["canonical-conversation-turn", turnId]), revision: projectionHash(["episode-revision", message.id, message.parts[0]!.id, "/text", contentHash, 1]), messageId: message.id, partId: message.parts[0]!.id, turnId });
      }
    } finally { canonical.close(); }
    const graphPath = join(butlerData, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite");
    const db = new Database(graphPath);
    try {
      const complete = JSON.stringify({ state: "complete" });
      for (const row of rows) {
        const sourceId = `source-${row.id}`, sessionId = `session-${row.id}`;
        const contentHash = createHash("sha256").update(row.text).digest("hex");
        db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,project_id,origin_kind,status,summary,summary_status,source_hash,created_at,updated_at) VALUES(?,?,?,?,?,NULL,'user_input','active',?,'complete',?,?,?)")
          .run(row.episodeId, row.episodeId, row.revision, sessionId, row.turnId, row.text, contentHash, row.observed, row.observed);
        db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES(?,?,?,'conversation',?,?,?,'/text',0,?,?, 'user','user_input',?,'user_statement')")
          .run(sourceId, row.episodeId, row.revision, sessionId, row.messageId, row.partId, Buffer.byteLength(row.text), contentHash, row.observed);
        db.query("INSERT INTO entities(id,type,label_original,properties,identity_scope,created_at) VALUES(?,?,?,?, 'user',?)")
          .run(row.id, row.type, row.text, JSON.stringify(row.properties), row.observed);
        for (const alias of row.aliases) db.query("INSERT INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,?,?,?,?,'create')").run(row.id, alias, alias, alias, sourceId);
        db.query("INSERT INTO entity_mentions(entity_id,source_id,episode_id,revision) VALUES(?,?,?,?)").run(row.id, sourceId, row.episodeId, row.revision);
        db.query("INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) VALUES(?,?,?,?,?,'model','medium','[]',?,?,?,?,?,?)")
          .run(`job-${row.id}`, row.episodeId, row.revision, "v", descriptor.generation_id, complete, complete, complete, complete, complete, row.observed);
      }
      db.query("INSERT INTO edges(edge_id,source_node_id,target_node_id,rel_type,valid_from,status) VALUES('later-correction','correction','expired','supersedes','2026-09-06T10:00:00Z','active')").run();
      db.query("INSERT INTO edge_evidence(edge_id,chunk_source_id,basis,extraction_version) VALUES('later-correction','source-correction','user_statement','v')").run();
      installAndBackfillRecallIndexes(db);
    } finally { db.close(); }
    const context = { butlerData, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: new AbortController().signal };
    const current = (cue: string) => recallSourceBackedMemory({ ...recallInput({ cue, asOf: "2026-09-08T23:00:00Z" }), context });
    const validRecall = await current("valid");
    expect(validRecall.results[0]?.summary).toBe("valid fact");
    expect((await current("expired")).results.every((result) => result.summary !== "expired fact")).toBe(true);
    expect((await current("future")).results.every((result) => result.summary !== "future fact")).toBe(true);
    const historical = await recallSourceBackedMemory({
      ...recallInput({ cue: "expired", asOf: "2026-09-04T23:00:00Z", time: { from: "2026-09-02T00:00:00Z", to: "2026-09-03T00:00:00Z", basis: "event" } }),
      context,
    });
    const expired = historical.results.find((result) => result.summary === "expired fact");
    expect(expired?.qualifications).toContain("historical");
    expect(expired?.evidence[0]?.excerpt).toBe("expired fact");
    const currentlyKnownHistory = await recallSourceBackedMemory({
      ...recallInput({ cue: "expired", asOf: "2026-09-08T23:00:00Z", time: { from: "2026-09-02T00:00:00Z", to: "2026-09-07T00:00:00Z", basis: "event" } }),
      context,
    });
    const knownExpired = currentlyKnownHistory.results.find((result) => result.summary === "expired fact");
    expect(knownExpired?.qualifications).toContain("historical");
    expect(knownExpired?.evidence[0]?.excerpt).toBe("expired fact");
    const priority = await current("priority");
    expect(priority.results[0]?.summary).toBe("priority rule when tired");
    expect(priority.results[0]?.evidence[0]?.excerpt).toBe("priority rule when tired");
    const rankingMetric = readOperationalMetricEvents({ butlerData }).find((event) =>
      event.category === "memory" && event.name === "recall_v2_ranking" && event.dimensions?.episode_sha256 === createHash("sha256").update(rows.find((row) => row.id === "rule")!.episodeId).digest("hex"));
    expect(rankingMetric?.rawTextStored).toBe(false);
    expect(rankingMetric?.dimensions).toMatchObject({
      native_operation_sha256: createHash("sha256").update("op").digest("hex"),
      vector_executed: false,
      graph_executed: true,
      lexical_executed: true,
      context_executed: true,
      ranking_stage: "candidate",
    });
    const returnedMetric = readOperationalMetricEvents({ butlerData }).find((event) =>
      event.category === "memory" && event.name === "recall_v2_ranking" && event.dimensions?.ranking_stage === "returned" &&
      event.dimensions?.episode_sha256 === rankingMetric?.dimensions?.episode_sha256 &&
      event.dimensions?.native_operation_sha256 === rankingMetric?.dimensions?.native_operation_sha256);
    expect(returnedMetric?.dimensions?.returned_rank).toBe(1);
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

test("multi-claim summary follows the hydrated cue-matched claim instead of UUID order", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t2-summary-"));
  try {
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const sessionId = "summary-session", turnId = "summary-turn", observed = "2026-09-01T00:00:00Z";
    const canonical = new AgentConversationStore({ butlerData });
    let request!: ReturnType<AgentConversationStore["appendUserMessage"]>;
    let assistant!: ReturnType<AgentConversationStore["appendAssistantMessage"]>;
    try {
      canonical.beginTurn({ gateway: "app", externalSessionId: sessionId, sessionId, actor: "user", turnId, now: observed });
      request = canonical.appendUserMessage({ sessionId, turnId, text: "alpha fact", originKind: "user_input", now: observed });
      assistant = canonical.appendAssistantMessage({ sessionId, turnId, text: "needle fact", originKind: "assistant_public", now: observed });
      canonical.finalizeTurn({ turnId, status: "complete", completedAt: observed, outcomeCapsule: { sessionId, turnId, generation: 1, outcome: "delivered", requestMessageId: request.id, publicAssistantMessageId: assistant.id } });
    } finally { canonical.close(); }
    const episodeId = projectionHash(["canonical-conversation-turn", turnId]);
    const requestHash = createHash("sha256").update("alpha fact").digest("hex");
    const assistantHash = createHash("sha256").update("needle fact").digest("hex");
    const revision = projectionHash(["episode-revision", request.id, request.parts[0]!.id, "/text", requestHash, assistant.id, assistant.parts[0]!.id, "/text", assistantHash, 1]);
    const db = new Database(join(butlerData, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite"));
    try {
      const complete = JSON.stringify({ state: "complete" });
      db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,project_id,origin_kind,status,summary,summary_status,source_hash,created_at,updated_at) VALUES(?,?,?,?,?,NULL,'user_input','active','episode summary','complete','h',?,?)")
        .run(episodeId, episodeId, revision, sessionId, turnId, observed, observed);
      for (const source of [
        { id: "source-a", message: request, text: "alpha fact", hash: requestHash, role: "user", origin: "user_input", basis: "user_statement", node: "a-claim", alias: "alpha" },
        { id: "source-b", message: assistant, text: "needle fact", hash: assistantHash, role: "assistant", origin: "assistant_public", basis: "assistant_statement", node: "b-claim", alias: "needle" },
      ]) {
        db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES(?,?,?,'conversation',?,?,?,'/text',0,?,?,?,?,?,?)")
          .run(source.id, episodeId, revision, sessionId, source.message.id, source.message.parts[0]!.id, Buffer.byteLength(source.text), source.hash, source.role, source.origin, observed, source.basis);
        db.query("INSERT INTO entities(id,type,label_original,properties,identity_scope,created_at) VALUES(?,'memory_atom',?,?,'user',?)")
          .run(source.node, source.text, JSON.stringify({ statement: source.text, valid_from: "2026-09-01T00:00:00Z" }), observed);
        db.query("INSERT INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,?,?,?,?,'create')")
          .run(source.node, source.alias, source.alias, source.alias, source.id);
        db.query("INSERT INTO entity_mentions(entity_id,source_id,episode_id,revision) VALUES(?,?,?,?)").run(source.node, source.id, episodeId, revision);
      }
      db.query("INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) VALUES('summary-job',?,?, 'v',?,'model','medium','[]',?,?,?,?,?,?)")
        .run(episodeId, revision, descriptor.generation_id, complete, complete, complete, complete, complete, observed);
      db.query("INSERT INTO edges(edge_id,source_node_id,target_node_id,rel_type,status) VALUES('summary-related','b-claim','a-claim','related_to','active')").run();
      db.query("INSERT INTO edge_evidence(edge_id,chunk_source_id,basis,extraction_version) VALUES('summary-related','source-b','assistant_statement','v')").run();
      installAndBackfillRecallIndexes(db);
    } finally { db.close(); }
    const recalled = await recallSourceBackedMemory({
      ...recallInput({ cue: "needle", asOf: "2026-09-08T00:00:00Z" }),
      context: { butlerData, target: { kind: "active", expected_generation: descriptor.generation_id }, signal: new AbortController().signal },
    });
    expect(recalled.results[0]?.summary).toBe("needle fact");
    expect(recalled.results[0]?.matched_node_ref).toBe("b-claim");
    expect(recalled.results[0]?.evidence.map((item) => Buffer.from(item.source_ref.split(":")[3]!, "base64url").toString("utf8"))).toEqual(["source-a", "source-b"]);
    expect(recalled.results[0]?.evidence.find((item) => Buffer.from(item.source_ref.split(":")[3]!, "base64url").toString("utf8") === "source-b")?.excerpt).toBe("needle fact");
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

test("serialization reduction rebinds summary, matched node, and path to surviving ordered evidence", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t2-reduction-"));
  try {
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const sessionId = "reduction-session", turnId = "reduction-turn", observed = "2026-09-01T00:00:00Z";
    const cluster = `a${"\u0301".repeat(40)}`;
    const alphaText = `alpha source ${cluster.repeat(500)}`;
    const needleText = `needle source ${cluster.repeat(500)}`;
    const canonical = new AgentConversationStore({ butlerData });
    let request!: ReturnType<AgentConversationStore["appendUserMessage"]>;
    let assistant!: ReturnType<AgentConversationStore["appendAssistantMessage"]>;
    try {
      canonical.beginTurn({ gateway: "app", externalSessionId: sessionId, sessionId, actor: "user", turnId, now: observed });
      request = canonical.appendUserMessage({ sessionId, turnId, text: alphaText, originKind: "user_input", now: observed });
      assistant = canonical.appendAssistantMessage({ sessionId, turnId, text: needleText, originKind: "assistant_public", now: observed });
      canonical.finalizeTurn({ turnId, status: "complete", completedAt: observed, outcomeCapsule: { sessionId, turnId, generation: 1, outcome: "delivered", requestMessageId: request.id, publicAssistantMessageId: assistant.id } });
    } finally { canonical.close(); }
    const episodeId = projectionHash(["canonical-conversation-turn", turnId]);
    const alphaHash = createHash("sha256").update(alphaText).digest("hex");
    const needleHash = createHash("sha256").update(needleText).digest("hex");
    const revision = projectionHash(["episode-revision", request.id, request.parts[0]!.id, "/text", alphaHash, assistant.id, assistant.parts[0]!.id, "/text", needleHash, 1]);
    const db = new Database(join(butlerData, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite"));
    try {
      const complete = JSON.stringify({ state: "complete" });
      db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,project_id,origin_kind,status,summary,summary_status,source_hash,created_at,updated_at) VALUES(?,?,?,?,?,NULL,'user_input','active','summary','complete','h',?,?)")
        .run(episodeId, episodeId, revision, sessionId, turnId, observed, observed);
      for (const source of [
        { id: "reduce-a", message: request, text: alphaText, hash: alphaHash, role: "user", origin: "user_input", basis: "user_statement", node: "reduce-a-claim", statement: "alpha fact", alias: "alpha" },
        { id: "reduce-b", message: assistant, text: needleText, hash: needleHash, role: "assistant", origin: "assistant_public", basis: "assistant_statement", node: "reduce-b-claim", statement: "needle fact", alias: "needle" },
      ]) {
        db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES(?,?,?,'conversation',?,?,?,'/text',0,?,?,?,?,?,?)")
          .run(source.id, episodeId, revision, sessionId, source.message.id, source.message.parts[0]!.id, Buffer.byteLength(source.text), source.hash, source.role, source.origin, observed, source.basis);
        db.query("INSERT INTO entities(id,type,label_original,properties,identity_scope,created_at) VALUES(?,'memory_atom',?,?,'user',?)")
          .run(source.node, source.statement, JSON.stringify({ statement: source.statement, valid_from: observed }), observed);
        db.query("INSERT INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,?,?,?,?,'create')")
          .run(source.node, source.alias, source.alias, source.alias, source.id);
        db.query("INSERT INTO entity_mentions(entity_id,source_id,episode_id,revision) VALUES(?,?,?,?)").run(source.node, source.id, episodeId, revision);
      }
      db.query("INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) VALUES('reduction-job',?,?,'v',?,'model','medium','[]',?,?,?,?,?,?)")
        .run(episodeId, revision, descriptor.generation_id, complete, complete, complete, complete, complete, observed);
      db.query("INSERT INTO edges(edge_id,source_node_id,target_node_id,rel_type,status) VALUES('reduction-related','reduce-b-claim','reduce-a-claim','related_to','active')").run();
      db.query("INSERT INTO edge_evidence(edge_id,chunk_source_id,basis,extraction_version) VALUES('reduction-related','reduce-b','assistant_statement','v')").run();
      installAndBackfillRecallIndexes(db);
    } finally { db.close(); }
    const recalled = await recallSourceBackedMemory({
      ...recallInput({ cue: "needle", asOf: "2026-09-08T00:00:00Z", limit: 1 }),
      context: { butlerData, target: { kind: "active", expected_generation: descriptor.generation_id }, signal: new AbortController().signal },
    });
    expect(recalled.coverage.source.codes).toContain("serialization_budget");
    expect(recalled.results[0]?.evidence.map((item) => Buffer.from(item.source_ref.split(":")[3]!, "base64url").toString("utf8"))).toEqual(["reduce-a"]);
    expect(recalled.results[0]?.summary).toBe("alpha fact");
    expect(recalled.results[0]?.matched_node_ref).toBe("reduce-a-claim");
    expect(recalled.results[0]?.association_path.at(-1)).toEqual({ from: "reduce-b-claim", relation: "related_to", to: "reduce-a-claim", traversed_reverse: false });
    expect(Buffer.byteLength(JSON.stringify(recalled))).toBeLessThanOrEqual(24 * 1024);
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

test("serialization refill reconsiders the highest ranked candidate popped for budget", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t2-refill-"));
  try {
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const observed = "2026-09-01T00:00:00Z";
    const cluster = `a${"\u0301".repeat(40)}`;
    const largeContext = `context ${cluster.repeat(500)}`;
    const largeClaim = `needle top ${cluster.repeat(500)}`;
    const canonical = new AgentConversationStore({ butlerData });
    const episodes: Array<{
      id: string;
      episodeId: string;
      revision: string;
      sessionId: string;
      turnId: string;
      sources: Array<{
        id: string;
        messageId: string;
        partId: string;
        text: string;
        hash: string;
        role: "user" | "assistant";
        origin: "user_input" | "assistant_public";
        basis: "user_statement" | "assistant_statement";
        node: string;
        type: "entity" | "memory_atom";
        statement: string;
        alias: string;
      }>;
    }> = [];
    try {
      for (const definition of [
        { id: "a", texts: [largeContext, largeClaim] },
        { id: "b", texts: ["needle second"] },
        { id: "c", texts: ["needle third"] },
      ]) {
        const sessionId = `refill-session-${definition.id}`;
        const turnId = `refill-turn-${definition.id}`;
        canonical.beginTurn({ gateway: "app", externalSessionId: sessionId, sessionId, actor: "user", turnId, now: observed });
        const request = canonical.appendUserMessage({ sessionId, turnId, text: definition.texts[0]!, originKind: "user_input", now: observed });
        const messages = [request];
        if (definition.texts[1]) messages.push(canonical.appendAssistantMessage({ sessionId, turnId, text: definition.texts[1], originKind: "assistant_public", now: observed }));
        canonical.finalizeTurn({
          turnId,
          status: "complete",
          completedAt: observed,
          outcomeCapsule: {
            sessionId,
            turnId,
            generation: 1,
            outcome: "delivered",
            requestMessageId: request.id,
            ...(messages[1] ? { publicAssistantMessageId: messages[1].id } : {}),
          },
        });
        const sourceParts = messages.map((message, index) => {
          const text = definition.texts[index]!;
          return {
            id: `refill-${definition.id}-${index}`,
            messageId: message.id,
            partId: message.parts[0]!.id,
            text,
            hash: createHash("sha256").update(text).digest("hex"),
            role: index === 0 ? "user" as const : "assistant" as const,
            origin: index === 0 ? "user_input" as const : "assistant_public" as const,
            basis: index === 0 ? "user_statement" as const : "assistant_statement" as const,
            node: `refill-${definition.id}-${index === 0 && definition.id === "a" ? "context" : "claim"}`,
            type: index === 0 && definition.id === "a" ? "entity" as const : "memory_atom" as const,
            statement: definition.id === "b" ? "needle second" : definition.id === "c" ? "needle third" : index === 0 ? "context" : "needle top",
            alias: index === 0 && definition.id === "a" ? "context" : "needle",
          };
        });
        episodes.push({
          id: definition.id,
          episodeId: projectionHash(["canonical-conversation-turn", turnId]),
          revision: projectionHash(["episode-revision", ...sourceParts.flatMap((source) => [source.messageId, source.partId, "/text", source.hash]), 1]),
          sessionId,
          turnId,
          sources: sourceParts,
        });
      }
    } finally { canonical.close(); }
    const db = new Database(join(butlerData, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite"));
    try {
      const complete = JSON.stringify({ state: "complete" });
      for (const episode of episodes) {
        db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,project_id,origin_kind,status,summary,summary_status,source_hash,created_at,updated_at) VALUES(?,?,?,?,?,NULL,'user_input','active',?,'complete','h',?,?)")
          .run(episode.episodeId, episode.episodeId, episode.revision, episode.sessionId, episode.turnId, `summary ${episode.id}`, observed, observed);
        for (const source of episode.sources) {
          db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES(?,?,?,'conversation',?,?,?,'/text',0,?,?,?,?,?,?)")
            .run(source.id, episode.episodeId, episode.revision, episode.sessionId, source.messageId, source.partId, Buffer.byteLength(source.text), source.hash, source.role, source.origin, observed, source.basis);
          db.query("INSERT INTO entities(id,type,label_original,properties,identity_scope,created_at) VALUES(?,?,?,?, 'user',?)")
            .run(source.node, source.type, source.statement, JSON.stringify({ statement: source.statement, valid_from: observed }), observed);
          db.query("INSERT INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,?,?,?,?,'create')")
            .run(source.node, source.alias, source.alias, source.alias, source.id);
          db.query("INSERT INTO entity_mentions(entity_id,source_id,episode_id,revision) VALUES(?,?,?,?)")
            .run(source.node, source.id, episode.episodeId, episode.revision);
        }
        db.query("INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) VALUES(?,?,?,?,?,'model','medium','[]',?,?,?,?,?,?)")
          .run(`refill-job-${episode.id}`, episode.episodeId, episode.revision, "v", descriptor.generation_id, complete, complete, complete, complete, complete, observed);
      }
      db.query("INSERT INTO edges(edge_id,source_node_id,target_node_id,rel_type,status) VALUES('refill-a-related','refill-a-claim','refill-a-context','related_to','active')").run();
      db.query("INSERT INTO edge_evidence(edge_id,chunk_source_id,basis,extraction_version) VALUES('refill-a-related','refill-a-1','assistant_statement','v')").run();
      installAndBackfillRecallIndexes(db);
    } finally { db.close(); }
    const recalled = await recallSourceBackedMemory({
      ...recallInput({ cue: "needle", asOf: "2026-09-08T00:00:00Z", limit: 3 }),
      context: { butlerData, target: { kind: "active", expected_generation: descriptor.generation_id }, signal: new AbortController().signal },
    });
    const candidateRanks = new Map(readOperationalMetricEvents({ butlerData })
      .filter((event) => event.category === "memory" && event.name === "recall_v2_ranking" && event.dimensions?.ranking_stage === "candidate")
      .map((event) => [event.dimensions?.episode_sha256, event.dimensions?.candidate_rank]));
    expect(episodes.map((episode) => candidateRanks.get(createHash("sha256").update(episode.episodeId).digest("hex")))).toEqual([1, 2, 3]);
    expect(recalled.coverage.source.codes).toContain("serialization_budget");
    expect(recalled.results.map((result) => result.episode_ref)).toEqual([episodes[1]!.episodeId]);
    expect(recalled.results[0]?.summary).toBe("needle second");
    expect(recalled.results[0]?.evidence.map((item) => Buffer.from(item.source_ref.split(":")[3]!, "base64url").toString("utf8"))).toEqual(["refill-b-0"]);
    expect(Buffer.byteLength(JSON.stringify(recalled))).toBeLessThanOrEqual(24 * 1024);
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

test("node vector projection identity includes deterministic condition and polarity fields", () => {
  const db = new Database(":memory:");
  ensureV2MemorySchema(db);
  const complete = JSON.stringify({ state: "complete" });
  db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,project_id,origin_kind,status,summary,summary_status,source_hash,created_at,updated_at) VALUES('episode','source','r1','session','turn',NULL,'user_input','active','summary','complete','h','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z')").run();
  db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES('source','episode','r1','conversation','session','message','part','/text',0,1,'h','user','user_input','2026-09-01T00:00:00Z','user_statement')").run();
  db.query("INSERT INTO entities(id,type,label_original,properties,identity_scope,created_at) VALUES('claim','constraint','label',?,'user','2026-09-01T00:00:00Z')")
    .run(JSON.stringify({ statement: "same", condition: "weekday", polarity: "positive" }));
  db.query("INSERT INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES('claim','별칭','별칭','별칭','source','create')").run();
  db.query("INSERT INTO entity_mentions(entity_id,source_id,episode_id,revision) VALUES('claim','source','episode','r1')").run();
  db.query("INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) VALUES('job','episode','r1','v','generation','model','medium','[]',?,?,?,?,?,'2026-09-01T00:00:00Z')")
    .run(complete, complete, complete, complete, complete);
  refreshVectorUnitsForJob(db, "job", "episode");
  const first = db.query<{ owner_revision: string; projection_text: string }, []>("SELECT owner_revision,projection_text FROM memory_vector_units WHERE record_kind='node'").get()!;
  expect(first.projection_text).toContain('statement:"same"\ncondition:"weekday"\npolarity:"positive"');
  db.query("DELETE FROM memory_vector_units WHERE record_kind='node'").run();
  db.query("UPDATE entities SET properties=? WHERE id='claim'").run(JSON.stringify({ statement: "same", condition: "weekend", polarity: "positive" }));
  refreshVectorUnitsForJob(db, "job", "episode");
  const conditionChanged = db.query<{ owner_revision: string }, []>("SELECT owner_revision FROM memory_vector_units WHERE record_kind='node'").get()!.owner_revision;
  expect(conditionChanged).not.toBe(first.owner_revision);
  db.query("DELETE FROM memory_vector_units WHERE record_kind='node'").run();
  db.query("UPDATE entities SET properties=? WHERE id='claim'").run(JSON.stringify({ statement: "same", condition: "weekend", polarity: "negative" }));
  refreshVectorUnitsForJob(db, "job", "episode");
  expect(db.query<{ owner_revision: string }, []>("SELECT owner_revision FROM memory_vector_units WHERE record_kind='node'").get()!.owner_revision).not.toBe(conditionChanged);
  db.close();
});

test("current vector filtering retains an exact current row behind a closer stale revision", () => {
  const db = new Database(":memory:");
  ensureV2MemorySchema(db);
  const state = JSON.stringify({ state: "complete" });
  db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,project_id,origin_kind,status,source_hash,created_at,updated_at) VALUES('episode','source','r1','session','turn',NULL,'user_input','active','h','2026-09-08T00:00:00Z','2026-09-08T00:00:00Z')").run();
  db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES('src','episode','r1','conversation','session','message','part','/text',0,1,'h','user','user_input','2026-09-08T00:00:00Z','user_statement')").run();
  db.query("INSERT INTO entities(id,type,label_original,identity_scope,created_at) VALUES('node','entity','node','user','2026-09-08T00:00:00Z')").run();
  db.query("INSERT INTO entity_mentions(entity_id,source_id,episode_id,revision) VALUES('node','src','episode','r1')").run();
  db.query("INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) VALUES('job','episode','r1','v','generation','model','medium','[]',?,?,?,?,?,'2026-09-08T00:00:00Z')")
    .run(state, state, state, state, state);
  db.query("INSERT INTO memory_vector_units(unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,state) VALUES('unit','job','node','node','node-r1',NULL,'user_input','node','complete')").run();
  const version = "1".repeat(64);
  const row = (ownerRevision: string, distance: number) => {
    const embeddingChunkId = "chunk";
    return {
      vectorKey: new Bun.CryptoHasher("sha256").update(JSON.stringify(["memory-vector", "generation", "node", "node", ownerRevision, embeddingChunkId, version])).digest("hex"),
      generation: "generation", embeddingChunkId, embeddingVersion: version, ownerId: "node", ownerRevision,
      sourceRevision: "r1", sourceRefsJson: '["src"]', projectId: "", originKind: "user_input",
      conversationSessionId: "session", sourceObservedAt: "2026-09-08T00:00:00Z", rank: 1, distance,
    };
  };
  const filtered = filterCurrentGenerationVectorMatches(db, {
    generationId: "generation", root: "/unused", graphPath: "/unused",
    embedding: {
      model: "test", dimension: 2, pooling: "cls", normalize: true, version, max_tokens: 8,
      transformers_version: "test", node_runtime_version: "test", bun_runtime_version: "test",
      tokenizer_asset_sha256: "2".repeat(64), model_asset_sha256: "3".repeat(64),
    },
  }, { nodes: [row("old", 0.01), row("node-r1", 0.02)], episodes: [], diagnostics: [] });
  expect(filtered.nodes.map((match) => match.ownerRevision)).toEqual(["node-r1"]);
  expect(filtered.partial).toBe(false);
  db.close();
});

test("current episode vector filtering retains more than 64 owners and caps at 128", () => {
  const db = new Database(":memory:");
  ensureV2MemorySchema(db);
  const complete = JSON.stringify({ state: "complete" });
  const version = "1".repeat(64);
  const matches: Parameters<typeof filterCurrentGenerationVectorMatches>[2]["episodes"] = [];
  for (let index = 0; index < 129; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const episodeId = `episode-${suffix}`, revision = `revision-${suffix}`, sourceId = `source-${suffix}`;
    const jobId = `job-${suffix}`, unitId = `unit-${suffix}`, embeddingChunkId = `chunk-${suffix}`;
    db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,project_id,origin_kind,status,source_hash,created_at,updated_at) VALUES(?,?,?,?,?,NULL,'user_input','active','h','2026-09-08T00:00:00Z','2026-09-08T00:00:00Z')")
      .run(episodeId, sourceId, revision, `session-${suffix}`, `turn-${suffix}`);
    db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES(?,?,?,'conversation',?,?,?,'/text',0,1,'h','user','user_input','2026-09-08T00:00:00Z','user_statement')")
      .run(sourceId, episodeId, revision, `session-${suffix}`, `message-${suffix}`, `part-${suffix}`);
    db.query("INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) VALUES(?,?,?,?, 'generation','model','medium','[]',?,?,?,?,?,'2026-09-08T00:00:00Z')")
      .run(jobId, episodeId, revision, "v", complete, complete, complete, complete, complete);
    db.query("INSERT INTO memory_vector_units(unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,state) VALUES(?,?,'episode',?,?,NULL,'user_input','episode','complete')")
      .run(unitId, jobId, episodeId, revision);
    matches.push({
      vectorKey: new Bun.CryptoHasher("sha256").update(JSON.stringify(["memory-vector", "generation", "episode", episodeId, revision, embeddingChunkId, version])).digest("hex"),
      generation: "generation", embeddingChunkId, embeddingVersion: version, ownerId: episodeId, ownerRevision: revision,
      sourceRevision: revision, sourceRefsJson: JSON.stringify([sourceId]), projectId: "", originKind: "user_input",
      conversationSessionId: `session-${suffix}`, sourceObservedAt: "2026-09-08T00:00:00Z", rank: index + 1, distance: index / 1000,
    });
  }
  const filtered = filterCurrentGenerationVectorMatches(db, {
    generationId: "generation", root: "/unused", graphPath: "/unused",
    embedding: {
      model: "test", dimension: 2, pooling: "cls", normalize: true, version, max_tokens: 8,
      transformers_version: "test", node_runtime_version: "test", bun_runtime_version: "test",
      tokenizer_asset_sha256: "2".repeat(64), model_asset_sha256: "3".repeat(64),
    },
  }, { nodes: [], episodes: matches, diagnostics: [] });
  expect(filtered.episodes).toHaveLength(128);
  expect(filtered.episodes[64]!.ownerId).toBe("episode-064");
  expect(filtered.partial).toBe(true);
  db.close();
});

test("native v2 scope validation rejects every supplied ID outside its canonical base scope", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t2-scope-"));
  try {
    initializeEmptyMemoryGeneration(butlerData);
    const canonical = new AgentConversationStore({ butlerData });
    try {
      canonical.beginTurn({ gateway: "app", externalSessionId: "current", sessionId: "current", projectId: "project-a", actor: "user", turnId: "current-turn" });
      canonical.beginTurn({ gateway: "app", externalSessionId: "outside", sessionId: "outside", projectId: "project-b", actor: "user", turnId: "outside-turn" });
    } finally { canonical.close(); }
    const handler = createRecallMemoryToolHandler({ butlerHome: butlerData, butlerData, sessionId: "current", turnId: "current-turn", currentUserMessage: "memory", projectId: "project-a" });
    const call = { name: "recall_memory", args: { cue: "memory", include_vector: false, scope: "current_project", session_ids: ["outside"] }, rawArguments: "{}", toolContractVersion: 2 } as const;
    await expect(handler(call, { effectOccurrenceId: "operation" })).rejects.toThrow("invalid_scope");
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

function recallInput(overrides: Partial<Parameters<typeof recallSourceBackedMemory>[0]> = {}): Parameters<typeof recallSourceBackedMemory>[0] {
  return {
    context: { butlerData: process.env.BUTLER_DATA!, target: { kind: "rebuild", generation_id: "x", canonical_snapshot_id: "x" }, signal: new AbortController().signal },
    cue: "memory",
    includeVector: false,
    includeInternal: false,
    limit: 6,
    scope: "all_user_sessions",
    projectFilter: "unassigned",
    projectIds: [],
    sessionIds: [],
    asOf: "2026-09-09T00:00:00Z",
    runtime: { sessionId: "s", turnId: "t", currentUserMessage: "memory", nativeOperationId: "op", projectId: null },
    ...overrides,
  };
}
