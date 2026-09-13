import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEmptyMemoryGeneration, reconcileMemoryGenerationHotCache } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { ensureV2MemorySchema, recordHotCacheOutcomes } from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";

test("cache eviction survives job receipt replacement; readmission makes missing data repairable", async () => {
  const data = mkdtempSync(join(tmpdir(), "butler-cache-readiness-"));
  let db: Database | undefined;
  try {
    const active = initializeEmptyMemoryGeneration(data);
    const id = active.generation_id;
    const root = join(data, "cognition/memory/generations", id);
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    // Fixture candidate; production admission is owned by the rebuild write gate.
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, state: "building", canonical_snapshot_id: "snapshot", canonical_snapshot_path: "snapshot/runtime/conversation-store.sqlite" }));
    mkdirSync(join(root, "snapshot/runtime"), { recursive: true });
    writeFileSync(join(root, "snapshot/memory-source-inventory.json"), JSON.stringify({ as_of: "2026-09-11T00:00:00Z" }));
    db = new Database(join(root, "graph.sqlite"));
    ensureV2MemorySchema(db);
    for (const entry of ["evicted", "readmitted", "missing"]) {
      db.query(`INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,summary_status,status,origin_kind,source_hash,created_at,updated_at) VALUES(?,?,?,'complete','active','user_input','hash','2026-09-11','2026-09-11')`).run(entry, entry, "r1");
      db.query(`INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,extraction_model,reasoning_effort,observed_completion_job_ids,created_at,hot_cache_receipt_json)
        VALUES(?,?,?,'v',?,'{}','{"state":"complete"}','{"state":"complete"}','{"state":"complete"}','{"state":"complete"}','model','medium','[]','2026-09-11',?)`)
        .run(entry, entry, "r1", id, JSON.stringify({entries:[{source_id:entry,source_revision:"r1",generation_id:id,admitted:true}]}));
    }
    recordHotCacheOutcomes(db, id, { source_id: "writer", admitted: true, excluded_entries: [{ entry_id: "evicted", reason: "budget" }, { entry_id: "readmitted", reason: "budget" }] });
    recordHotCacheOutcomes(db, id, { source_id: "readmitted", admitted: true });
    // The emitting job receipt can disappear without deleting the admission record.
    recordHotCacheOutcomes(db, id, { source_id: "writer", admitted: true });
    const before = db.query("SELECT job_id,semantic_graph_state,node_vectors_state,episode_vectors_state FROM memory_projection_jobs ORDER BY job_id").all();
    const context = {butlerData:data,target:{kind:"rebuild" as const,generation_id:id,canonical_snapshot_id:"snapshot"},signal:new AbortController().signal};
    expect(await reconcileMemoryGenerationHotCache(context)).toBe(2);
    expect(db.query("SELECT job_id FROM memory_projection_jobs WHERE json_extract(hot_cache_state,'$.state')='pending' ORDER BY job_id").all()).toEqual([{job_id:"missing"},{job_id:"readmitted"}]);
    expect(db.query("SELECT job_id,semantic_graph_state,node_vectors_state,episode_vectors_state FROM memory_projection_jobs ORDER BY job_id").all()).toEqual(before);
    expect(await reconcileMemoryGenerationHotCache(context)).toBe(0);
  } finally { db?.close(); rmSync(data, {recursive:true,force:true}); }
});
