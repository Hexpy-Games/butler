import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { advanceNextMemoryProjection, ingestConversationMemory, resolveMemorySource } from "../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts";
import { ensureV2MemorySchema, claimNextProjectionWindow, claimNextVectorQuantum, completeVectorQuantum, expandSplitSourceLeaves, failVectorQuantum, invalidatePlannedWindow, markPlannedWindowFailure, markWindowFailure, progressFromDb, refreshSemanticState, refreshVectorUnitsForJob, saveValidatedPlan, selectNextProjectionJob, sourceRows } from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";
import { OPENAI_PROVIDER_ADAPTER } from "../../packages/butler-agent/src/integrations/providers/openai/adapter.ts";
import { ModelProviderRequestError } from "../../packages/butler-agent/src/integrations/providers/provider-request-errors.ts";
import { assertPlanCandidatesCurrent, type NormalizedPlan } from "../../packages/butler-agent/src/agent/cognition/memory/projection/plan.ts";
import { MEMORY_SPLIT_MIN_SOURCE_BYTES, graphemeByteBoundaries, nearestGraphemeByteMidpoint, splitGraphemeUtf8Spans } from "../../packages/butler-agent/src/agent/cognition/memory/projection/windows.ts";
import { runCanonicalMemoryCatchup } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/phases/catchup.ts";

test("T3 grapheme windows preserve exact UTF-8 coverage and expose oversized leaves", () => {
  const text = `${"a".repeat(7_900)}${"가".repeat(100)}${"👩‍👩‍👧‍👦".repeat(30)}`;
  const bytes = Buffer.from(text);
  const spans = splitGraphemeUtf8Spans(text);
  expect(spans[0]!.start).toBe(0);
  expect(spans.at(-1)!.end).toBe(bytes.length);
  expect(spans.every((span, index) => index === 0 || spans[index - 1]!.end === span.start)).toBe(true);
  expect(spans.every((span) => span.oversized || span.end - span.start <= 8 * 1024)).toBe(true);
  const boundaries = new Set(graphemeByteBoundaries(text));
  expect(spans.every((span) => boundaries.has(span.start) && boundaries.has(span.end))).toBe(true);
  const oneOversized = splitGraphemeUtf8Spans("a".repeat(32), 0);
  expect(oneOversized.every((span) => span.oversized)).toBe(true);
  expect(nearestGraphemeByteMidpoint([{ text: "a".repeat(8_000), bytes: 8_000 }])).toEqual({ partIndex: 0, localByte: 4_000 });
  expect(nearestGraphemeByteMidpoint([
    { text: "a".repeat(7_900), bytes: 7_900 },
    { text: `${"가".repeat(33)}a`, bytes: 100 },
  ])).toEqual({ partIndex: 0, localByte: 4_000 });
});

test("T3 legacy failure migration preserves diagnostic attempt and fixed retry state", () => {
  const db = new Database(":memory:");
  ensureV2MemorySchema(db);
  // Simulate an installed pre-T3 store. Fresh stores already carry the one-shot marker.
  db.query("DELETE FROM memory_state WHERE key='t3_legacy_failure_migration'").run();
  db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,project_id,origin_kind,status,source_hash,created_at,updated_at) VALUES('ep','k','r','s',NULL,'user_input','active','h','2026-09-08T00:00:00Z','2026-09-08T00:00:00Z')").run();
  db.query(`INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,extraction_model,reasoning_effort,observed_completion_job_ids,created_at)
    VALUES('job','ep','r','memory-extract-v2','g','{"state":"complete","completed_units":1,"total_units":1}','{"state":"failed","code":"memory_extract_invalid_quote","retryable":false,"next_attempt_at":null}','{"state":"pending","blocked_by":null}','{"state":"pending","blocked_by":null}','{"state":"pending","blocked_by":null}','model','medium','[]','2026-09-08T00:00:00Z')`).run();
  db.query("INSERT INTO memory_projection_windows(window_ref,job_id,ordinal,source_refs_json,output_json,provider_evidence_json,state,error_code) VALUES('window','job',0,'[]','{\"bad\":true}','{\"provider\":\"safe\"}','failed','memory_extract_invalid_quote')").run();

  ensureV2MemorySchema(db);
  const migrated = db.query<{ state: string; attempt_count: number; input_migration_note: string }, []>("SELECT state,attempt_count,input_migration_note FROM memory_projection_windows").get()!;
  expect(migrated).toEqual({ state: "pending", attempt_count: 1, input_migration_note: "legacy_input_unavailable" });
  expect(db.query<{ output_json: string; provider_evidence_json: string }, []>("SELECT output_json,provider_evidence_json FROM memory_projection_attempts").get()).toEqual({
    output_json: '{"bad":true}', provider_evidence_json: '{"provider":"safe"}',
  });
  const dueAt = db.query<{ next_attempt_at: string }, []>("SELECT next_attempt_at FROM memory_projection_windows").get()!.next_attempt_at;
  const beforeDue = new Date(Date.parse(dueAt) - 1).toISOString();
  expect(claimNextProjectionWindow(db, { jobId: "job", now: beforeDue, ownerPid: process.pid, ownerNonce: "early" })).toBeNull();
  const claimed = claimNextProjectionWindow(db, { jobId: "job", now: dueAt, ownerPid: process.pid, ownerNonce: "owner" });
  expect(claimed?.attemptCount).toBe(2);
  const retryAt = new Date(Date.parse(dueAt) + 120_000).toISOString();
  markWindowFailure(db, "job", "window", "memory_extract_invalid_quote", { retryAt, ownerNonce: "owner" });
  const retry = db.query<{ state: string; attempt_count: number; next_attempt_at: string }, []>("SELECT state,attempt_count,next_attempt_at FROM memory_projection_windows").get()!;
  expect(retry).toEqual({ state: "pending", attempt_count: 2, next_attempt_at: retryAt });
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM memory_projection_attempts").get()!.n).toBe(2);
  refreshSemanticState(db, "job");
  expect(JSON.parse(db.query<{ semantic_graph_state: string }, []>("SELECT semantic_graph_state FROM memory_projection_jobs").get()!.semantic_graph_state).state).toBe("pending");
  db.close();
});

test("T3 normal registration keeps ordered recursive leaves and reuses completed descendants", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t3-split-"));
  const original = OPENAI_PROVIDER_ADAPTER.runPrompt;
  let calls = 0;
  OPENAI_PROVIDER_ADAPTER.runPrompt = async () => {
    if (++calls <= 2) throw new ModelProviderRequestError({ code: "context_length_exceeded", message: "injected input limit" });
    return { text: JSON.stringify({ status: "processed", entities: [], items: [], attributes: [] }), model: "gpt-5.6-sol", usage: null } as never;
  };
  let db: Database | undefined;
  try {
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const store = new AgentConversationStore({ butlerData });
    // Two midpoint splits need four leaves above the production minimum.
    const unit = "샌디é👩‍👩‍👧‍👦";
    const text = unit.repeat(Math.ceil(4 * MEMORY_SPLIT_MIN_SOURCE_BYTES / Buffer.byteLength(unit)) + 2);
    store.beginTurn({ gateway: "app", externalSessionId: "split-session", sessionId: "split-session", actor: "user", turnId: "split-turn" });
    const message = store.appendUserMessage({ sessionId: "split-session", turnId: "split-turn", text, originKind: "user_input", originRef: "test" });
    store.finalizeTurn({ turnId: "split-turn", status: "complete", outcomeCapsule: { sessionId: "split-session", turnId: "split-turn", generation: 1, outcome: "delivered", requestMessageId: message.id } });
    store.close();
    const context = { butlerData, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: new AbortController().signal };
    const notice = { kind: "conversation_turn" as const, session_id: "split-session", turn_id: "split-turn", outcome_generation: 1 };
    const registered = await ingestConversationMemory({ context, source: notice });
    db = new Database(join(butlerData, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite"));
    const parent = db.query<{ window_ref: string; source_refs_json: string }, []>("SELECT window_ref,source_refs_json FROM memory_projection_windows").get()!;
    const refs = JSON.parse(parent.source_refs_json) as string[];
    expect(refs).toHaveLength(1);
    const childrenOf = (windowRef: string) => db!.query<{ window_ref: string }, [string]>(
      "SELECT window_ref FROM memory_projection_windows WHERE parent_window_ref=? ORDER BY ordinal",
    ).all(windowRef).map((row) => row.window_ref);
    const advanceMeaning = async () => {
      // Select the stage under test; leave splitting, validation and completion to production.
      db!.query("UPDATE memory_projection_jobs SET next_stage='semantic_graph' WHERE job_id=?").run(registered.job_id);
      await advanceNextMemoryProjection({ context });
    };
    await advanceMeaning();
    const firstChildren = childrenOf(parent.window_ref);
    expect(firstChildren).toHaveLength(2);
    await advanceMeaning();
    const secondChildren = childrenOf(firstChildren[0]!);
    expect(secondChildren).toHaveLength(2);
    await advanceMeaning();
    expect(calls).toBe(3);

    const active = db.query<{ window_ref: string; ordinal: number; source_refs_json: string; state: string; output_json: string | null }, []>(
      "SELECT window_ref,ordinal,source_refs_json,state,output_json FROM memory_projection_windows WHERE state!='replaced' ORDER BY ordinal",
    ).all();
    expect(active.map((row) => row.window_ref)).toEqual([...secondChildren, firstChildren[1]!]);
    expect(active.map((row) => row.state)).toEqual(["complete", "pending", "pending"]);
    expect(active[0]!.output_json).not.toBeNull();
    expect(new Set(active.map((row) => row.ordinal)).size).toBe(active.length);
    const leaves = active.flatMap((row) => JSON.parse(row.source_refs_json) as string[]);
    expect(expandSplitSourceLeaves(db, refs[0]!)).toEqual(leaves);
    const spans = sourceRows(db, leaves);
    expect(spans.map((row) => row.source_id)).toEqual(leaves);
    const boundaries = new Set(graphemeByteBoundaries(text));
    expect(spans[0]!.byte_start).toBe(0);
    expect(spans.at(-1)!.byte_end).toBe(Buffer.byteLength(text));
    expect(spans.every((row, index) => row.byte_end > row.byte_start && boundaries.has(row.byte_start) && boundaries.has(row.byte_end)
      && (index === 0 || spans[index - 1]!.byte_end === row.byte_start))).toBe(true);
    const cachedText = leaves.map((id) => db!.query<{ text: string }, [string]>("SELECT text FROM memory_source_text WHERE source_id=?").get(id)!.text).join("");
    expect(cachedText).toBe(text);
    await ingestConversationMemory({ context, source: notice, completionJobId: "same-notice" });
    expect(db.query("SELECT window_ref,ordinal,source_refs_json,state,output_json FROM memory_projection_windows WHERE state!='replaced' ORDER BY ordinal").all()).toEqual(active);
    expect(calls).toBe(3);
  } finally { OPENAI_PROVIDER_ADAPTER.runPrompt = original; db?.close(); rmSync(butlerData, { recursive: true, force: true }); }
});

test("T3 saved plan keeps its owner and input while stale candidate invalidation clears only that window", () => {
  const db = new Database(":memory:");
  ensureV2MemorySchema(db);
  db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,project_id,origin_kind,status,source_hash,created_at,updated_at) VALUES('ep','k','r','s',NULL,'user_input','active','h','2026-09-08T00:00:00Z','2026-09-08T00:00:00Z')").run();
  db.query(`INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,extraction_model,reasoning_effort,observed_completion_job_ids,created_at)
    VALUES('job','ep','r','memory-extract-v2','g','{"state":"complete","completed_units":1,"total_units":1}','{"state":"pending","blocked_by":null}','{"state":"pending","blocked_by":null}','{"state":"pending","blocked_by":null}','{"state":"pending","blocked_by":null}','model','medium','[]','2026-09-08T00:00:00Z')`).run();
  db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES('src','ep','r','conversation','s','m','p','/text',0,4,'h','user','user_input','2026-09-08T00:00:00Z','user_statement')").run();
  db.query("INSERT INTO memory_nodes(id,type,label_original,identity_scope,project_id,created_at) VALUES('candidate','entity','Luna','user',NULL,'2026-09-08T00:00:00Z')").run();
  db.query("INSERT INTO memory_evidence(node_id,source_id,episode_id,revision) VALUES('candidate','src','ep','r')").run();
  db.query("INSERT INTO memory_projection_windows(window_ref,job_id,ordinal,source_refs_json,state,input_json,input_sha256) VALUES('window','job',0,'[\"src\"]','pending','{\"fixed\":true}','input-hash')").run();
  const claimed = claimNextProjectionWindow(db, { jobId: "job", ownerNonce: "owner-1" })!;
  const output = { schema: "butler.memory-extract-output.v2", window_ref: "window", disposition: "processed", covered_unit_refs: ["src"], nodes: [], claims: [], relations: [], corrections: [], summary: null } as any;
  const plan: NormalizedPlan = { refs: { reused: "candidate" }, evidence: {}, candidate_bindings: { reused: { node_ref: "candidate", type: "entity", scope: "user", project_id: null, evidence: [{ source_ref: "src", episode_ref: "ep", revision: "r", content_hash: "h" }] } } };
  saveValidatedPlan(db, "job", "window", claimed.ownerNonce, output, plan);
  markPlannedWindowFailure(db, "job", "window", claimed.ownerNonce, "memory_write_busy", "2000-01-01T00:00:00Z");
  const resumed = claimNextProjectionWindow(db, { jobId: "job", ownerNonce: "owner-2" })!;
  expect(resumed).toMatchObject({ previousState: "planned", attemptCount: 2, pinnedInput: { fixed: true }, plan });
  db.query("UPDATE memory_nodes SET identity_scope='project',project_id='other' WHERE id='candidate'").run();
  expect(() => assertPlanCandidatesCurrent(db, "/nonexistent", { episode_ref: "ep", revision: "r", bound_project_id: null } as any, resumed.plan as NormalizedPlan)).toThrow("memory_extract_candidate_changed");
  invalidatePlannedWindow(db, "job", "window", resumed.ownerNonce, "memory_extract_candidate_changed");
  expect(db.query<{ state: string; input_json: string | null; normalized_plan_json: string | null }, []>("SELECT state,input_json,normalized_plan_json FROM memory_projection_windows").get()).toEqual({ state: "pending", input_json: null, normalized_plan_json: null });
  db.close();
});

test("T3 vector owner preserves successful units while bounded retries and explicit failures leave truthful coverage", () => {
  const db = new Database(":memory:");
  ensureV2MemorySchema(db);
  db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,project_id,origin_kind,status,source_hash,created_at,updated_at) VALUES('ep','k','r','s',NULL,'user_input','active','h','2026-09-08T00:00:00Z','2026-09-08T00:00:00Z')").run();
  db.query(`INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,extraction_model,reasoning_effort,observed_completion_job_ids,created_at)
    VALUES('job','ep','r','memory-extract-v2','g','{"state":"complete","completed_units":2,"total_units":2}','{"state":"pending","blocked_by":null}','{"state":"pending","blocked_by":null}','{"state":"pending","blocked_by":null}','{"state":"pending","blocked_by":null}','model','medium','[]','2026-09-08T00:00:00Z')`).run();
  for (const [sourceId, partId, byteEnd] of [["stable", "p1", 6], ["long", "p2", 16_001]] as const) {
    db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES(?,'ep','r','conversation','s','m',?,'/text',0,?,'h','user','user_input','2026-09-08T00:00:00Z','user_statement')").run(sourceId, partId, byteEnd);
  }
  const stable = { sourceId: "stable", text: "stable", role: "user", byteStart: 0 };
  const long = { sourceId: "long", text: "x".repeat(16_001), role: "user", byteStart: 0 };
  refreshVectorUnitsForJob(db, "job", [stable, long]);
  expect(progressFromDb(db, "job").node_vectors).toEqual({ state: "pending", blocked_by: "semantic_graph" });
  const first = claimNextVectorQuantum(db, { jobId: "job", kind: "episode", now: "2026-09-09T00:00:00Z", ownerPid: process.pid, ownerNonce: "vector-owner-1" });
  expect(first).toHaveLength(4);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM memory_vector_units WHERE state='pending'").get()!.n).toBe(2);
  completeVectorQuantum(db, first, { rows: 4, version: "measured" });
  const tail = claimNextVectorQuantum(db, { jobId: "job", kind: "episode", now: "2026-09-09T00:00:00Z", ownerPid: process.pid, ownerNonce: "vector-owner-tail" });
  completeVectorQuantum(db, tail, { rows: tail.length, version: "measured" });
  const stableUnit = db.query<{ unit_id: string; receipt_json: string }, []>("SELECT unit_id,receipt_json FROM memory_vector_units WHERE source_ids_json='[\"stable\"]'").get()!;
  refreshVectorUnitsForJob(db, "job", [stable, { ...long, sourceId: "long-child-a", text: long.text.slice(0, 8_000) }, { ...long, sourceId: "long-child-b", text: long.text.slice(8_000), byteStart: 8_000 }]);
  expect(db.query<{ state: string; receipt_json: string }, [string]>("SELECT state,receipt_json FROM memory_vector_units WHERE unit_id=?").get(stableUnit.unit_id)).toEqual({ state: "complete", receipt_json: stableUnit.receipt_json });
  const retry = claimNextVectorQuantum(db, { jobId: "job", kind: "episode", now: "2026-09-09T00:00:00Z", ownerPid: process.pid, ownerNonce: "vector-owner-2" });
  expect(retry).toHaveLength(4);
  failVectorQuantum(db, retry, "embed_busy", "2026-09-09T00:02:00Z");
  const unaffectedPending = claimNextVectorQuantum(db, { jobId: "job", kind: "episode", now: "2026-09-09T00:01:00Z", ownerPid: process.pid, ownerNonce: "vector-owner-unaffected" });
  expect(unaffectedPending).toHaveLength(1);
  completeVectorQuantum(db, unaffectedPending, { rows: 1, version: "measured" });
  expect(claimNextVectorQuantum(db, { jobId: "job", kind: "episode", now: "2026-09-09T00:01:00Z" })).toHaveLength(0);
  expect(progressFromDb(db, "job").episode_vectors.state).toBe("partial");
  const due = claimNextVectorQuantum(db, { jobId: "job", kind: "episode", now: "2026-09-09T00:03:00Z", ownerPid: process.pid, ownerNonce: "vector-owner-3" });
  expect(due).toHaveLength(4);

  refreshVectorUnitsForJob(db, "job", [stable, { sourceId: "oversized", text: `a${"\u0301".repeat(4_001)}`, role: "user", byteStart: 0 }]);
  expect(db.query<{ error_code: string; state: string }, []>("SELECT error_code,state FROM memory_vector_units WHERE error_code='memory_vector_oversized_grapheme'").get()).toEqual({ error_code: "memory_vector_oversized_grapheme", state: "failed" });
  expect(progressFromDb(db, "job").episode_vectors.state).toBe("partial");
  db.close();
});

test("T3 advance resumes a verified persisted vector row without embedding it twice", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t3-vector-writer-"));
  try {
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const store = new AgentConversationStore({ butlerData });
    store.beginTurn({ gateway: "app", externalSessionId: "vector-session", sessionId: "vector-session", actor: "user", turnId: "vector-turn" });
    const message = store.appendUserMessage({ sessionId: "vector-session", turnId: "vector-turn", text: "Luna vector source", originKind: "user_input", originRef: "test" });
    store.finalizeTurn({ turnId: "vector-turn", status: "complete", outcomeCapsule: { sessionId: "vector-session", turnId: "vector-turn", generation: 1, outcome: "delivered", requestMessageId: message.id } });
    store.close();
    const context = { butlerData, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: new AbortController().signal };
    const registered = await ingestConversationMemory({ context, source: { kind: "conversation_turn", session_id: "vector-session", turn_id: "vector-turn", outcome_generation: 1 } });
    const graphPath = join(butlerData, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite");
    let db = new Database(graphPath);
    const source = db.query<{ source_id: string; revision: string; observed_at: string }, []>("SELECT source_id,revision,observed_at FROM memory_chunk_sources ORDER BY source_id LIMIT 1").get()!;
    db.query("INSERT INTO memory_nodes(id,type,label_original,identity_scope,project_id,created_at) VALUES('vector-node','entity','Luna','user',NULL,?)").run(source.observed_at);
    db.query("INSERT INTO memory_evidence(node_id,source_id,episode_id,revision) VALUES('vector-node',?,?,?)").run(source.source_id, registered.episode_id, source.revision);
    db.query("UPDATE memory_projection_jobs SET semantic_graph_state=?,next_stage='node_vectors' WHERE job_id=?")
      .run(JSON.stringify({ state: "complete", completed_units: 1, total_units: 1 }), registered.job_id);
    refreshVectorUnitsForJob(db, registered.job_id, [{ sourceId: source.source_id, text: "Luna vector source", role: "user", byteStart: 0 }]);
    db.exec("CREATE TRIGGER interrupt_vector_receipt BEFORE UPDATE OF state ON memory_vector_units WHEN NEW.state='complete' BEGIN SELECT RAISE(ABORT, 'memory_write_busy'); END");
    db.close();

    const socketPath = process.env.EMBED_SOCKET!;
    let embeddingRequests = 0;
    const server = createServer((socket) => {
      let payload = "";
      let responded = false;
      socket.on("data", (chunk) => { payload += chunk.toString(); });
      socket.on("end", () => undefined);
      socket.on("data", () => {
        if (responded || !payload.includes("\n")) return;
        responded = true;
        const request = JSON.parse(payload.trim()) as { texts: string[] };
        embeddingRequests += 1;
        socket.end(`${JSON.stringify({
          embeddings: request.texts.map(() => [1, 0]), token_counts: request.texts.map(() => 2), embedded_texts: request.texts,
          omitted_count: 0,
          metadata: { model: "test/bge-m3", dimension: 2, pooling: "cls", normalize: true, version: "a".repeat(64), max_tokens: 8192,
            transformers_version: "test", node_runtime_version: process.version, bun_runtime_version: Bun.version,
            tokenizer_asset_sha256: "b".repeat(64), model_asset_sha256: "c".repeat(64) },
        })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    try {
      const interrupted = await advanceNextMemoryProjection({ context });
      expect(interrupted?.node_vectors.state).toBe("pending");
      expect(embeddingRequests).toBe(1);
      db = new Database(graphPath);
      db.exec("DROP TRIGGER interrupt_vector_receipt");
      db.query("UPDATE memory_vector_units SET next_attempt_at='2000-01-01T00:00:00Z' WHERE record_kind='node' AND state='pending'").run();
      db.query("UPDATE memory_projection_jobs SET next_stage='node_vectors' WHERE job_id=?").run(registered.job_id);
      db.close();
      const resumed = await advanceNextMemoryProjection({ context });
      expect(resumed?.node_vectors.state).toBe("complete");
      expect(embeddingRequests).toBe(1);
      db = new Database(graphPath, { readonly: true });
      const receipt = db.query<{ state: string; receipt_json: string }, []>("SELECT state,receipt_json FROM memory_vector_units WHERE record_kind='node'").get()!;
      expect(receipt.state).toBe("complete");
      expect(JSON.parse(receipt.receipt_json).row_count).toBe(1);
      db.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

test("T3 scheduler serves jobs fairly and rotates independently runnable stages", () => {
  const db = new Database(":memory:");
  ensureV2MemorySchema(db);
  const stage = JSON.stringify({ state: "pending", blocked_by: null });
  for (const [job, created] of [["a", "2026-09-08T00:00:00Z"], ["b", "2026-09-08T00:00:01Z"]] as const) {
    db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,project_id,origin_kind,status,summary,summary_status,source_hash,created_at,updated_at) VALUES(?,?,?,? ,NULL,'user_input','active','summary','complete','h',?,?)")
      .run(`ep-${job}`, `k-${job}`, `r-${job}`, `s-${job}`, created, created);
    db.query(`INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,extraction_model,reasoning_effort,observed_completion_job_ids,created_at)
      VALUES(?,?,?,'memory-extract-v2','g',?,?,?,?,?,'model','medium','[]',?)`)
      .run(job, `ep-${job}`, `r-${job}`, JSON.stringify({ state: "complete", completed_units: 1, total_units: 1 }), stage, stage, stage, stage, created);
    db.query("INSERT INTO memory_projection_windows(window_ref,job_id,ordinal,source_refs_json,state) VALUES(?,?,0,'[]','pending')").run(`w-${job}`, job);
    for (const kind of ["node", "episode"] as const) db.query("INSERT INTO memory_vector_units(unit_id,job_id,record_kind,owner_id,owner_revision,origin_kind,projection_text,state) VALUES(?,?,?,?,?,'user_input','text','pending')")
      .run(`${job}-${kind}`, job, kind, `${job}-${kind}`, `r-${job}`);
  }
  expect(selectNextProjectionJob(db, "2026-09-09T00:00:00Z")).toEqual({ jobId: "a", stage: "semantic_graph" });
  expect(selectNextProjectionJob(db, "2026-09-09T00:00:01Z")).toEqual({ jobId: "b", stage: "semantic_graph" });
  db.query("UPDATE memory_projection_jobs SET last_served_at=NULL WHERE job_id='a'").run();
  expect([
    selectNextProjectionJob(db, "2026-09-09T00:00:02Z")?.stage,
    selectNextProjectionJob(db, "2026-09-09T00:00:03Z")?.stage,
    selectNextProjectionJob(db, "2026-09-09T00:00:04Z")?.stage,
  ]).toEqual(["node_vectors", "node_vectors", "hot_cache"]);
  db.close();
});

test("T3 hot-cache quantum retries I/O and publishes each current summary revision idempotently", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t3-cache-"));
  const original = OPENAI_PROVIDER_ADAPTER.runPrompt;
  let calls = 0;
  OPENAI_PROVIDER_ADAPTER.runPrompt = async (request) => {
    calls++;
    const prompt = JSON.parse(request.prompt);
    return { text: JSON.stringify({ status: "processed", entities: [],
      items: [{ kind: "fact", subject: null, text: prompt.parts[0].text, evidence: [prompt.parts[0].id] }], attributes: [] }),
      model: "gpt-5.6-sol", usage: null } as never;
  };
  let db: Database | undefined;
  try {
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const store = new AgentConversationStore({ butlerData });
    store.beginTurn({ gateway: "app", externalSessionId: "cache-session", sessionId: "cache-session", actor: "user", turnId: "cache-turn" });
    const message = store.appendUserMessage({ sessionId: "cache-session", turnId: "cache-turn", text: "first summary", originKind: "user_input", originRef: "test",
      parts: ["first summary", "second summary"].map((text) => ({ kind: "text" as const, contentJson: { text } })) });
    store.finalizeTurn({ turnId: "cache-turn", status: "complete", outcomeCapsule: { sessionId: "cache-session", turnId: "cache-turn", generation: 1, outcome: "delivered", requestMessageId: message.id } });
    store.close();
    const context = { butlerData, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: new AbortController().signal };
    const notice = { kind: "conversation_turn" as const, session_id: "cache-session", turn_id: "cache-turn", outcome_generation: 1 };
    const registered = await ingestConversationMemory({ context, source: notice });
    const generationRoot = join(butlerData, "cognition", "memory", "generations", descriptor.generation_id);
    db = new Database(join(generationRoot, "graph.sqlite"));
    const advanceStage = async (stage: "semantic_graph" | "hot_cache") => {
      db!.query("UPDATE memory_projection_jobs SET next_stage=? WHERE job_id=?").run(stage, registered.job_id);
      return advanceNextMemoryProjection({ context });
    };
    await advanceStage("semantic_graph");
    expect(calls).toBe(1);
    const completed = db.query<{ input_json: string; output_json: string; normalized_plan_json: string }, []>(
      "SELECT input_json,output_json,normalized_plan_json FROM memory_projection_windows WHERE state='complete'",
    ).all();
    expect(completed).toHaveLength(1);
    expect(JSON.parse(completed[0]!.input_json).source_units).toHaveLength(1);
    expect(JSON.parse(completed[0]!.output_json).summary.evidence).toHaveLength(1);
    expect(JSON.parse(completed[0]!.normalized_plan_json).refs).toBeDefined();

    writeFileSync(join(generationRoot, "hot"), "blocks-directory");
    const failed = await advanceStage("hot_cache");
    expect(failed?.hot_cache).toMatchObject({ state: "pending", blocked_by: "hot_cache_io_failed" });
    const retryAt = db.query<{ hot_cache_next_attempt_at: string }, []>("SELECT hot_cache_next_attempt_at FROM memory_projection_jobs").get()!.hot_cache_next_attempt_at;
    expect(Number.isFinite(Date.parse(retryAt))).toBe(true);
    rmSync(join(generationRoot, "hot"));
    mkdirSync(join(generationRoot, "hot"), { recursive: true });
    db.query("UPDATE memory_projection_jobs SET hot_cache_next_attempt_at='2000-01-01T00:00:00Z' WHERE job_id=?").run(registered.job_id);
    expect((await advanceStage("hot_cache"))?.hot_cache.state).toBe("complete");
    const cachePath = join(generationRoot, "hot", "cache.md");
    const firstCache = readFileSync(cachePath, "utf8");
    expect(firstCache).toContain("first summary");
    expect(firstCache).not.toContain("second summary");

    // A second real completed window changes the summary; no direct summary injection.
    await advanceStage("semantic_graph");
    expect(calls).toBe(2);
    expect(db.query("SELECT window_ref FROM memory_projection_windows WHERE state!='complete'").all()).toEqual([]);
    expect((await advanceStage("hot_cache"))?.hot_cache.state).toBe("complete");
    const cache = readFileSync(cachePath, "utf8");
    expect(cache).toContain("first summary");
    expect(cache).toContain("second summary");
    const pending = JSON.stringify({ state: "pending", blocked_by: null });
    db.query("UPDATE memory_projection_jobs SET hot_cache_state=?,hot_cache_next_attempt_at=NULL WHERE job_id=?").run(pending, registered.job_id);
    expect((await advanceStage("hot_cache"))?.hot_cache.state).toBe("complete");
    expect(readFileSync(cachePath, "utf8")).toBe(cache);
    const replay = await ingestConversationMemory({ context, source: notice, completionJobId: "cache-replay" });
    expect(replay.hot_cache.state).toBe("complete");
    expect(readFileSync(cachePath, "utf8")).toBe(cache);
    expect(calls).toBe(2);
  } finally { OPENAI_PROVIDER_ADAPTER.runPrompt = original; db?.close(); rmSync(butlerData, { recursive: true, force: true }); }
});

test("T3 canonical catchup reads terminal outcomes by keyset and only calls ingestion", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t3-catchup-"));
  try {
    const store = new AgentConversationStore({ butlerData });
    store.beginTurn({ gateway: "app", externalSessionId: "session", sessionId: "session", actor: "user", turnId: "turn" });
    const message = store.appendUserMessage({ sessionId: "session", turnId: "turn", text: "canonical source", originKind: "user_input", originRef: "test" });
    store.finalizeTurn({ turnId: "turn", status: "complete", outcomeCapsule: { sessionId: "session", turnId: "turn", generation: 1, outcome: "delivered", requestMessageId: message.id } });
    store.close();
    const notices: unknown[] = [];
    const first = await runCanonicalMemoryCatchup({ butlerData, state: { outcomeCursor: null, recoveredMessageCursor: null }, limit: 1,
      ingest: async (source, observationId) => { notices.push({ source, observationId }); } });
    expect(first).toMatchObject({ scanned: 1, ingested: 1 });
    expect(notices).toHaveLength(1);
    expect((notices[0] as any).source).toMatchObject({ kind: "conversation_turn", session_id: "session", turn_id: "turn", outcome_generation: 1 });
    const wrapped = await runCanonicalMemoryCatchup({ butlerData, state: first.state, limit: 1, ingest: async () => {} });
    expect(wrapped.wrapped).toBe(true);
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

test("T3 canonical catchup reserves work for recovered sources behind a full outcome page", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t3-catchup-fair-"));
  try {
    const store = new AgentConversationStore({ butlerData });
    for (let index = 0; index < 3; index += 1) {
      const turnId = `turn-${index}`;
      store.beginTurn({ gateway: "app", externalSessionId: "session", sessionId: "session", actor: "user", turnId });
      const message = store.appendUserMessage({ sessionId: "session", turnId, text: `canonical-${index}`, originKind: "user_input", originRef: "test" });
      store.finalizeTurn({ turnId, status: "complete", outcomeCapsule: { sessionId: "session", turnId, generation: 1, outcome: "delivered", requestMessageId: message.id } });
    }
    store.appendAssistantMessage({ sessionId: "session", turnId: null, text: "recovered assistant", status: "complete", provenance: "recovered", originKind: "assistant_public", originRef: "test" });
    store.close();
    const notices: Array<{ source: any; observationId: string }> = [];
    const result = await runCanonicalMemoryCatchup({ butlerData, state: { outcomeCursor: null, recoveredMessageCursor: null }, limit: 3,
      ingest: async (source, observationId) => { notices.push({ source, observationId }); } });
    expect(result).toMatchObject({ scanned: 3, ingested: 3 });
    expect(notices.filter((item) => item.source.kind === "conversation_turn")).toHaveLength(2);
    expect(notices.find((item) => item.source.kind === "conversation_message")?.observationId).toStartWith("catchup:message:");
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});

test("T3 recovered public user, compacted user, and assistant sources hydrate without a turn", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t3-recovered-"));
  try {
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const store = new AgentConversationStore({ butlerData });
    store.beginTurn({ gateway: "app", externalSessionId: "recovered-session", sessionId: "recovered-session", actor: "user", turnId: "session-anchor" });
    const messages = [
      store.appendUserMessage({ sessionId: "recovered-session", turnId: null, text: "recovered user", status: "failed", provenance: "recovered", originKind: "user_input", originRef: "test" }),
      store.appendUserMessage({ sessionId: "recovered-session", turnId: null, text: "compacted user", status: "compacted", provenance: "imported", originKind: "user_input", originRef: "test" }),
      store.appendAssistantMessage({ sessionId: "recovered-session", turnId: null, text: "recovered assistant", status: "complete", provenance: "recovered", originKind: "assistant_public", originRef: "test" }),
    ];
    store.close();
    const context = { butlerData, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: new AbortController().signal };
    for (const message of messages) {
      const sourceHash = new Bun.CryptoHasher("sha256").update(JSON.stringify(message.parts.map((part) => [part.id, part.content_json]))).digest("hex");
      const progress = await ingestConversationMemory({ context, source: { kind: "conversation_message", session_id: message.session_id, message_id: message.id, source_hash: sourceHash } });
      const graph = new Database(join(butlerData, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite"), { readonly: true });
      const sourceRef = graph.query<{ source_id: string }, [string]>("SELECT source_id FROM memory_chunk_sources WHERE episode_id=? ORDER BY source_id LIMIT 1").get(progress.episode_id)!.source_id;
      graph.close();
      expect(resolveMemorySource({ context, sourceRef }).text).toBe(message.role === "assistant" ? "recovered assistant" : message.status === "compacted" ? "compacted user" : "recovered user");
    }
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
});
