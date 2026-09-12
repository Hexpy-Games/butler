import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  initializeEmptyMemoryGeneration,
  writeMemoryGenerationManifest,
  type MemoryGenerationHandle,
} from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import {
  ensureV2MemorySchema,
  openProjectionDb,
  type ClaimedVectorUnit,
} from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";
import {
  countInvalidPersistedVectorReadiness,
  generationVectorIdentity,
  writeGenerationVectorRows,
  type GenerationVectorRow,
} from "../../packages/butler-agent/src/agent/cognition/memory/recall/vector.ts";
import {
  embedCheckedViaSocket,
  type EmbeddingRuntimeMetadata,
} from "../../packages/butler-agent/src/agent/cognition/memory/scripts/embed.ts";
import { runMemoryRebuildCommand } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";

const roots: string[] = [];
const embedding: EmbeddingRuntimeMetadata = {
  model: "test", dimension: 2, pooling: "cls", normalize: true,
  version: "a".repeat(64), max_tokens: 512,
  transformers_version: "test", node_runtime_version: "test", bun_runtime_version: null,
  tokenizer_asset_sha256: "b".repeat(64), model_asset_sha256: "c".repeat(64),
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("memory vector UTF-8 repair", () => {
  test("preserves a multilingual checked response across a split UTF-8 socket packet", async () => {
    const root = mkdtempSync(join(tmpdir(), "butler-embed-utf8-"));
    roots.push(root);
    const socketPath = join(root, "embed.sock");
    const text = "한국어 العربية 日本語";
    const response = Buffer.from(`${JSON.stringify({
      embeddings: [[0.25, 0.75]], token_counts: [3], embedded_texts: [text],
      omitted_count: 0, metadata: embedding,
    })}\n`);
    const splitAt = response.indexOf(Buffer.from("한")) + 1;
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write(response.subarray(0, splitAt));
        setTimeout(() => socket.end(response.subarray(splitAt)), 5);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      const result = await embedCheckedViaSocket({ texts: [text], socketPath, resplit: true });
      expect(result.embedded_texts).toEqual([text]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("repairs only selected receipt-invalid shared nodes through retry-failed", async () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-vector-repair-"));
    roots.push(butlerData);
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    writeMemoryGenerationManifest(butlerData, descriptor.generation_id, (current) => ({
      ...current,
      embedding,
    }));
    const generationRoot = join(butlerData, "cognition", "memory", "generations", descriptor.generation_id);
    const graphPath = join(generationRoot, "graph.sqlite");
    const generation: MemoryGenerationHandle = {
      generationId: descriptor.generation_id,
      root: generationRoot,
      graphPath,
      embedding,
      sourceRoot: butlerData,
      canonicalSnapshotPath: null,
    };
    const db = openProjectionDb(graphPath);
    ensureV2MemorySchema(db);
    const now = "2026-09-11T00:00:00.000Z";
    db.query("INSERT INTO entities(id,type,label_original,properties,identity_scope,project_id,created_at) VALUES('shared-node','entity','공유 노드','{}','project','project-a',?)").run(now);
    const insertScope = (suffix: string, hotCacheState: string) => {
      db.query(`INSERT INTO memory_chunks
        (memory_chunk_id,source_key,current_revision,conversation_session_id,project_id,origin_kind,status,source_hash,created_at,updated_at)
        VALUES(?,?,?,?,?,'user_input','complete',?,?,?)`)
        .run(`episode-${suffix}`, `source-key-${suffix}`, "source-r1", `session-${suffix}`, "project-a", `source-hash-${suffix}`, now, now);
      db.query(`INSERT INTO memory_chunk_sources
        (source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,
         byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis)
        VALUES(?,?,'source-r1','conversation',?,?,?,'/content',0,12,?,'user','user_input',?,'canonical')`)
        .run(`source-${suffix}`, `episode-${suffix}`, `session-${suffix}`, `message-${suffix}`, `part-${suffix}`, `content-hash-${suffix}`, now);
      db.query("INSERT INTO entity_mentions(entity_id,source_id,episode_id,revision) VALUES('shared-node',?,?,'source-r1')")
        .run(`source-${suffix}`, `episode-${suffix}`);
      db.query(`INSERT INTO memory_projection_jobs
        (job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,
         source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at)
        VALUES(?,?,'source-r1','memory-extract-v2',?,'test','low','[]',?,?,?,?,?,?)`)
        .run(`job-${suffix}`, `episode-${suffix}`, descriptor.generation_id,
          JSON.stringify({ state: "complete" }), JSON.stringify({ state: "complete" }),
          JSON.stringify({ state: "complete" }), JSON.stringify({ state: "complete" }), hotCacheState, now);
    };
    insertScope("a", JSON.stringify({ state: "failed", code: "preserve_me" }));
    insertScope("b", JSON.stringify({ state: "complete" }));
    insertScope("c", JSON.stringify({ state: "complete" }));
    db.query(`INSERT INTO memory_projection_windows
      (window_ref,job_id,ordinal,source_refs_json,state,error_code,normalized_plan_json)
      VALUES('window-a','job-a',0,'["source-a"]','failed','preserve_me',NULL)`).run();

    const projectionText = "type:\"entity\"\nlabel:\"공유 노드\"";
    const expectedIdentity = generationVectorIdentity({
      generationId: descriptor.generation_id, recordKind: "node", ownerId: "shared-node",
      ownerRevision: "shared-projection-r1", embeddingText: projectionText, ordinal: 0, embeddingVersion: embedding.version,
    });
    const wrongReceipt = JSON.stringify({ generation: descriptor.generation_id, embedding_version: embedding.version,
      vector_keys: ["d".repeat(64)], row_count: 1 });
    const healthyReceipt = JSON.stringify({ generation: descriptor.generation_id, embedding_version: embedding.version,
      vector_keys: [expectedIdentity.vectorKey], row_count: 1 });
    const makeUnit = (suffix: string, receiptJson: string) => {
      db.query(`INSERT INTO memory_vector_units
        (unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,state,receipt_json,source_ids_json)
        VALUES(?,?,'node','shared-node','shared-projection-r1','project-a','user_input',?,'complete',?,?)`)
        .run(`unit-${suffix}`, `job-${suffix}`, projectionText, receiptJson, JSON.stringify([`source-${suffix}`]));
    };
    makeUnit("a", wrongReceipt);
    makeUnit("b", healthyReceipt);
    makeUnit("c", healthyReceipt);
    const row = (input: { key: string; chunk: string; sourceSuffix: string }): GenerationVectorRow => ({
      vector_key: input.key, generation: descriptor.generation_id, record_kind: "node", owner_id: "shared-node",
      owner_revision: "shared-projection-r1", source_revision: "source-r1", embedding_chunk_id: input.chunk,
      embedding_version: embedding.version, project_id: "project-a", origin_kind: "user_input", source_kind: "conversation",
      conversation_session_id: `session-${input.sourceSuffix}`, source_observed_at: now,
      source_refs_json: JSON.stringify([`source-${input.sourceSuffix}`]), text: "", vector: [0.25, 0.75],
    });
    await writeGenerationVectorRows(generation, [
      row({ key: "d".repeat(64), chunk: "e".repeat(64), sourceSuffix: "a" }),
      row({ key: expectedIdentity.vectorKey, chunk: expectedIdentity.embeddingChunkId, sourceSuffix: "c" }),
    ]);

    const requestPath = join(butlerData, "repair.json");
    const requestUnit = (unit_id: string, owner_revision: string, receipt_json: string) => ({
      unit_id, owner_revision, source_revision: "source-r1", receipt_json,
    });
    writeFileSync(requestPath, JSON.stringify({ generation_id: descriptor.generation_id, units: [
      requestUnit("unit-a", "shared-projection-r1", wrongReceipt),
      requestUnit("unit-b", "shared-projection-r1", healthyReceipt),
    ] }));
    const argv = ["--memory-rebuild", "retry-failed", "--generation", descriptor.generation_id,
      "--vector-repair-input", requestPath];
    await expect(runMemoryRebuildCommand({ butlerData, argv, signal: new AbortController().signal }))
      .rejects.toThrow("memory_vector_repair_preimage_changed");
    expect(db.query<{ state: string }, []>("SELECT state FROM memory_vector_units WHERE unit_id='unit-a'").get()?.state)
      .toBe("complete");

    writeFileSync(requestPath, JSON.stringify({ generation_id: descriptor.generation_id,
      units: [requestUnit("unit-a", "shared-projection-r1", wrongReceipt)] }));
    const result = await runMemoryRebuildCommand({ butlerData, argv, signal: new AbortController().signal });
    expect(result).toMatchObject({ retried: { semantic_windows: 0, vector_units: 1, cache_jobs: 0 } });
    expect(db.query<{ state: string; receipt_json: string | null }, []>(
      "SELECT state,receipt_json FROM memory_vector_units WHERE unit_id='unit-a'",
    ).get()).toEqual({ state: "pending", receipt_json: null });
    expect(db.query<{ state: string }, []>("SELECT state FROM memory_vector_units WHERE unit_id='unit-b'").get()?.state)
      .toBe("complete");
    expect(db.query<{ state: string }, []>("SELECT state FROM memory_projection_windows WHERE window_ref='window-a'").get()?.state)
      .toBe("failed");
    expect(db.query<{ hot_cache_state: string }, []>("SELECT hot_cache_state FROM memory_projection_jobs WHERE job_id='job-a'").get()?.hot_cache_state)
      .toBe(JSON.stringify({ state: "failed", code: "preserve_me" }));
    db.close();
  });

  test("public rebuild build reconciles only a superseded shared-node representative before readiness", async () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-vector-representative-"));
    roots.push(butlerData);
    new AgentConversationStore({ butlerData }).close();
    initializeEmptyMemoryGeneration(butlerData);
    const prepared = await runMemoryRebuildCommand({
      butlerData, argv: ["--memory-rebuild", "prepare"], signal: new AbortController().signal,
    });
    const generationId = String(prepared.generationId);
    writeMemoryGenerationManifest(butlerData, generationId, (current) => ({ ...current, embedding }));
    const generationRoot = join(butlerData, "cognition", "memory", "generations", generationId);
    const graphPath = join(generationRoot, "graph.sqlite");
    const generation: MemoryGenerationHandle = {
      generationId, root: generationRoot, graphPath, embedding,
      sourceRoot: generationRoot, canonicalSnapshotPath: null,
    };
    const db = openProjectionDb(graphPath);
    ensureV2MemorySchema(db);
    const now = "2026-09-13T00:00:00.000Z";
    db.query("INSERT INTO entities(id,type,label_original,properties,identity_scope,project_id,created_at) VALUES('shared-node','entity','공유 노드','{}','project','project-a',?)").run(now);
    const projectionText = "type:\"entity\"\nlabel:\"공유 노드\"";
    const identity = generationVectorIdentity({ generationId, recordKind: "node", ownerId: "shared-node",
      ownerRevision: "shared-projection-r1", embeddingText: projectionText, ordinal: 0, embeddingVersion: embedding.version });
    const receipt = JSON.stringify({ generation: generationId, embedding_version: embedding.version,
      vector_keys: [identity.vectorKey], row_count: 1 });
    const units: ClaimedVectorUnit[] = [];
    for (const [suffix, state, observed] of [["a", "complete", "2026-09-11T00:00:00.000Z"],
      ["b", "complete", "2026-09-12T00:00:00.000Z"], ["stale", "superseded", now]] as const) {
      const revision = `source-r-${suffix}`;
      db.query(`INSERT INTO memory_chunks
        (memory_chunk_id,source_key,current_revision,conversation_session_id,project_id,origin_kind,status,source_hash,created_at,updated_at)
        VALUES(?,?,?,?,?,'user_input','complete',?,?,?)`)
        .run(`episode-${suffix}`, `source-key-${suffix}`, revision, `session-${suffix}`, "project-a", `source-hash-${suffix}`, now, now);
      db.query(`INSERT INTO memory_chunk_sources
        (source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,
         byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis)
        VALUES(?,?,?,'conversation',?,?,?,'/content',0,12,?,'user','user_input',?,'canonical')`)
        .run(`source-${suffix}`, `episode-${suffix}`, revision, `session-${suffix}`, `message-${suffix}`, `part-${suffix}`, `content-hash-${suffix}`, observed);
      db.query("INSERT INTO entity_mentions(entity_id,source_id,episode_id,revision) VALUES('shared-node',?,?,?)")
        .run(`source-${suffix}`, `episode-${suffix}`, revision);
      const complete = JSON.stringify({ state: "complete" });
      const cacheReceipt = JSON.stringify({ outcome: "excluded", reason: "no_summary",
        generation: generationId, source_revision: revision });
      db.query(`INSERT INTO memory_projection_jobs
        (job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,
         source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,hot_cache_receipt_json,created_at)
        VALUES(?,?,?,'memory-extract-v2',?,'test','low','[]',?,?,?,?,?,?,?)`)
        .run(`job-${suffix}`, `episode-${suffix}`, revision, generationId, complete, complete, complete, complete, complete, cacheReceipt, now);
      db.query(`INSERT INTO memory_vector_units
        (unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,state,receipt_json,source_ids_json)
        VALUES(?,?,'node','shared-node','shared-projection-r1','project-a','user_input',?,?,?,?)`)
        .run(`unit-${suffix}`, `job-${suffix}`, projectionText, state, receipt, JSON.stringify([`source-${suffix}`]));
      db.query(`INSERT INTO memory_vector_units
        (unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,state,source_ids_json)
        VALUES(?,?,'episode',?,?,'project-a','user_input','','superseded',?)`)
        .run(`episode-unit-${suffix}`, `job-${suffix}`, `episode-${suffix}`, `episode-r-${suffix}`, JSON.stringify([`source-${suffix}`]));
      units.push({ unit_id: `unit-${suffix}`, job_id: `job-${suffix}`, record_kind: "node", owner_id: "shared-node",
        owner_revision: "shared-projection-r1", project_id: "project-a", origin_kind: "user_input", projection_text: projectionText,
        source_revision: revision, conversation_session_id: `session-${suffix}`, source_kind: "conversation",
        source_observed_at: observed, source_ids_json: JSON.stringify([`source-${suffix}`]), receipt_json: receipt,
        attempt_count: 1, owner_nonce: `nonce-${suffix}` });
    }
    await writeGenerationVectorRows(generation, [{
      vector_key: identity.vectorKey, generation: generationId, record_kind: "node", owner_id: "shared-node",
      owner_revision: "shared-projection-r1", source_revision: "source-r-stale", embedding_chunk_id: identity.embeddingChunkId,
      embedding_version: embedding.version, project_id: "project-a", origin_kind: "user_input", source_kind: "conversation",
      conversation_session_id: "session-stale", source_observed_at: now, source_refs_json: '["source-stale"]',
      text: "", vector: [0.25, 0.75],
    }]);
    expect(await countInvalidPersistedVectorReadiness(generation, units.slice(0, 2), embedding.version)).toBe(2);
    const graphBefore = JSON.stringify(db.query("SELECT unit_id,state,receipt_json FROM memory_vector_units ORDER BY unit_id").all());
    db.close();

    const result = await runMemoryRebuildCommand({
      butlerData, argv: ["--memory-rebuild", "build", "--generation", generationId], signal: new AbortController().signal,
    });
    expect(result.vector_reconciliation).toEqual({ repaired_vector_keys: [identity.vectorKey], affected_unit_ids: ["unit-a", "unit-b"] });
    expect(await countInvalidPersistedVectorReadiness(generation, units.slice(0, 2), embedding.version)).toBe(0);
    const check = new Database(graphPath, { readonly: true });
    expect(JSON.stringify(check.query("SELECT unit_id,state,receipt_json FROM memory_vector_units ORDER BY unit_id").all())).toBe(graphBefore);
    check.close();
  });
});
