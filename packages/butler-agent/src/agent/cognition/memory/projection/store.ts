import { Database } from "bun:sqlite";
import type {
  ExtractOutput,
  MemoryJobProgress,
  StageState,
} from "./contracts.ts";

export type ProjectionSourceRow = {
  source_id: string;
  episode_id: string;
  revision: string;
  source_kind: string;
  conversation_session_id: string;
  conversation_message_id: string;
  part_id: string;
  scalar_pointer: string;
  byte_start: number;
  byte_end: number;
  content_hash: string;
  role: "user" | "assistant";
  origin_kind: string;
  observed_at: string;
  basis: string;
};

export function openProjectionDb(path: string, readonly = false): Database {
  const db = new Database(
    path,
    readonly ? { readonly: true } : { create: false, readwrite: true },
  );
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}

export function ensureV2MemorySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT OR IGNORE INTO memory_state(key,value) VALUES('graph_revision','0');
    CREATE TABLE IF NOT EXISTS memory_chunks(
      memory_chunk_id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE,
      current_revision TEXT NOT NULL, conversation_session_id TEXT,
      conversation_turn_id TEXT, conversation_start TEXT, conversation_end TEXT,
      project_id TEXT, origin_kind TEXT NOT NULL, status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '', summary_status TEXT NOT NULL DEFAULT 'pending',
      source_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_chunk_sources(
      source_id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES memory_chunks(memory_chunk_id),
      revision TEXT NOT NULL, source_kind TEXT NOT NULL,
      conversation_session_id TEXT NOT NULL, conversation_message_id TEXT NOT NULL,
      part_id TEXT NOT NULL, scalar_pointer TEXT NOT NULL,
      byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL, content_hash TEXT NOT NULL,
      role TEXT NOT NULL, origin_kind TEXT NOT NULL, observed_at TEXT NOT NULL, basis TEXT NOT NULL,
      UNIQUE(episode_id,revision,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end)
    );
    CREATE TABLE IF NOT EXISTS entities(
      id TEXT PRIMARY KEY, type TEXT NOT NULL, label_original TEXT NOT NULL,
      properties TEXT NOT NULL DEFAULT '{}', identity_scope TEXT NOT NULL,
      project_id TEXT, canonical_node_id TEXT REFERENCES entities(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entity_aliases(
      entity_id TEXT NOT NULL REFERENCES entities(id), surface_original TEXT NOT NULL,
      nfc_key TEXT NOT NULL, folded_key TEXT NOT NULL, language_tags TEXT NOT NULL DEFAULT '[]',
      source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id), resolution_kind TEXT NOT NULL,
      PRIMARY KEY(entity_id,surface_original,source_id)
    );
    CREATE TABLE IF NOT EXISTS entity_mentions(
      entity_id TEXT NOT NULL REFERENCES entities(id), source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),
      episode_id TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(entity_id,source_id)
    );
    CREATE TABLE IF NOT EXISTS edges(
      edge_id TEXT PRIMARY KEY, source_node_id TEXT NOT NULL REFERENCES entities(id),
      target_node_id TEXT NOT NULL REFERENCES entities(id), rel_type TEXT NOT NULL,
      claim_node_id TEXT REFERENCES entities(id), qualifiers TEXT NOT NULL DEFAULT '{}',
      valid_from TEXT, valid_to TEXT, status TEXT NOT NULL DEFAULT 'active',
      UNIQUE(source_node_id,target_node_id,rel_type,claim_node_id,qualifiers)
    );
    CREATE TABLE IF NOT EXISTS edge_evidence(
      edge_id TEXT NOT NULL REFERENCES edges(edge_id), chunk_source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),
      basis TEXT NOT NULL, extraction_version TEXT NOT NULL, PRIMARY KEY(edge_id,chunk_source_id)
    );
    CREATE TABLE IF NOT EXISTS memory_projection_jobs(
      job_id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, revision TEXT NOT NULL,
      extraction_version TEXT NOT NULL, generation TEXT NOT NULL,
      extraction_model TEXT NOT NULL, reasoning_effort TEXT NOT NULL,
      observed_completion_job_ids TEXT NOT NULL, source_state TEXT NOT NULL,
      semantic_graph_state TEXT NOT NULL, episode_vectors_state TEXT NOT NULL,
      node_vectors_state TEXT NOT NULL, hot_cache_state TEXT NOT NULL,
      next_stage TEXT NOT NULL DEFAULT 'semantic_graph', last_served_at TEXT,
      created_at TEXT NOT NULL, UNIQUE(episode_id,revision,extraction_version)
    );
    CREATE TABLE IF NOT EXISTS memory_projection_windows(
      window_ref TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES memory_projection_jobs(job_id),
      ordinal INTEGER NOT NULL, source_refs_json TEXT NOT NULL, output_json TEXT, normalized_plan_json TEXT,
      provider_evidence_json TEXT, state TEXT NOT NULL, error_code TEXT, UNIQUE(job_id,ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_alias_nfc ON entity_aliases(nfc_key,entity_id);
    CREATE INDEX IF NOT EXISTS idx_alias_folded ON entity_aliases(folded_key,entity_id);
    CREATE INDEX IF NOT EXISTS idx_edges_source_rel ON edges(source_node_id,rel_type);
    CREATE INDEX IF NOT EXISTS idx_edges_target_rel ON edges(target_node_id,rel_type);
    CREATE INDEX IF NOT EXISTS idx_mentions_entity_episode ON entity_mentions(entity_id,episode_id);
    CREATE INDEX IF NOT EXISTS idx_sources_message_revision ON memory_chunk_sources(conversation_message_id,revision);
    CREATE INDEX IF NOT EXISTS idx_chunks_project_origin ON memory_chunks(project_id,origin_kind,conversation_start,memory_chunk_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_state ON memory_projection_jobs(last_served_at,created_at,job_id);
  `);
}

export function progressFromDb(db: Database, jobId: string): MemoryJobProgress {
  const row = db
    .query<
      Record<string, string>,
      [string]
    >("SELECT * FROM memory_projection_jobs WHERE job_id=?")
    .get(jobId);
  if (!row) throw new Error("memory_projection_job_not_found");
  const source = JSON.parse(row.source_state) as StageState;
  const semantic = JSON.parse(row.semantic_graph_state) as StageState;
  const episodeVectors = JSON.parse(row.episode_vectors_state) as StageState;
  const nodeVectors = JSON.parse(row.node_vectors_state) as StageState;
  const hotCache = JSON.parse(row.hot_cache_state) as StageState;
  const states = [source, semantic, episodeVectors, nodeVectors, hotCache];
  const outcome = states.every((state) => state.state === "complete")
    ? "complete"
    : source.state !== "complete"
      ? "pending"
      : "partial";
  return {
    job_id: row.job_id,
    observed_completion_job_ids: JSON.parse(row.observed_completion_job_ids),
    episode_id: row.episode_id,
    revision: row.revision,
    extraction_version: "memory-extract-v2",
    generation: row.generation,
    source,
    semantic_graph: semantic,
    episode_vectors: episodeVectors,
    node_vectors: nodeVectors,
    hot_cache: hotCache,
    outcome,
  };
}

export type ClaimedProjectionWindow = {
  job_id: string;
  window_ref: string;
  sourceRefs: string[];
  model: string;
  reasoningEffort: string;
  previousState: "pending" | "planned";
  output: ExtractOutput | null;
  plan: unknown;
};

export function claimNextProjectionWindow(
  db: Database,
): ClaimedProjectionWindow | null {
  return db.transaction(() => {
    const row = db
      .query<
        {
          job_id: string;
          window_ref: string;
          source_refs_json: string;
          extraction_model: string;
          reasoning_effort: string;
          state: "pending" | "planned";
          output_json: string | null;
          normalized_plan_json: string | null;
        },
        []
      >(
        `
    SELECT w.job_id,w.window_ref,w.source_refs_json,j.extraction_model,j.reasoning_effort,
           w.state,w.output_json,w.normalized_plan_json
    FROM memory_projection_windows w
    JOIN memory_projection_jobs j ON j.job_id=w.job_id
    WHERE w.state IN ('pending','planned')
    ORDER BY j.last_served_at IS NOT NULL,j.last_served_at,j.created_at,j.job_id,w.ordinal LIMIT 1
    `,
      )
      .get();
    if (!row) return null;
    db.query(
      "UPDATE memory_projection_windows SET state='running' WHERE window_ref=? AND state=?",
    ).run(row.window_ref, row.state);
    return {
      job_id: row.job_id,
      window_ref: row.window_ref,
      sourceRefs: JSON.parse(row.source_refs_json),
      model: row.extraction_model,
      reasoningEffort: row.reasoning_effort,
      previousState: row.state,
      output: row.output_json
        ? (JSON.parse(row.output_json) as ExtractOutput)
        : null,
      plan: row.normalized_plan_json
        ? JSON.parse(row.normalized_plan_json)
        : null,
    };
  })();
}

export function markWindowFailure(
  db: Database,
  jobId: string,
  windowRef: string,
  code: string,
): void {
  db.transaction(() => {
    db.query(
      "UPDATE memory_projection_windows SET state='failed',error_code=? WHERE window_ref=?",
    ).run(code, windowRef);
    refreshSemanticState(db, jobId);
  })();
}

export function saveValidatedPlan(
  db: Database,
  jobId: string,
  windowRef: string,
  output: ExtractOutput,
  plan: unknown,
): void {
  db.query(
    "UPDATE memory_projection_windows SET output_json=?,normalized_plan_json=?,state='planned',error_code=NULL WHERE window_ref=? AND job_id=?",
  ).run(JSON.stringify(output), JSON.stringify(plan), windowRef, jobId);
}

export function refreshSemanticState(db: Database, jobId: string): void {
  const counts = db
    .query<{ total: number; complete: number; failed: number }, [string]>(
      `
    SELECT COUNT(*) total,SUM(state='complete') complete,SUM(state IN ('failed','unsupported')) failed
    FROM memory_projection_windows WHERE job_id=?
  `,
    )
    .get(jobId) ?? { total: 0, complete: 0, failed: 0 };
  const total = Number(counts.total),
    complete = Number(counts.complete),
    failed = Number(counts.failed);
  const pending = Math.max(0, total - complete - failed);
  const state: StageState =
    complete === total
      ? { state: "complete", completed_units: complete, total_units: total }
      : complete > 0 || failed > 0
        ? {
            state: "partial",
            completed_units: complete,
            total_units: total,
            pending_units: pending,
            failed_units: failed,
          }
        : { state: "pending", blocked_by: null };
  db.query(
    "UPDATE memory_projection_jobs SET semantic_graph_state=?,last_served_at=? WHERE job_id=?",
  ).run(JSON.stringify(state), new Date().toISOString(), jobId);
}

export function sourceRows(
  db: Database,
  sourceIds: string[],
): ProjectionSourceRow[] {
  if (sourceIds.length === 0) return [];
  return db
    .query<
      ProjectionSourceRow,
      string[]
    >(`SELECT * FROM memory_chunk_sources WHERE source_id IN (${sourceIds.map(() => "?").join(",")})`)
    .all(...sourceIds);
}
