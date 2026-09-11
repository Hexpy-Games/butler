import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
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
  role: "user" | "assistant" | "task" | "explicit";
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
  migrateNullableCanonicalSourceIds(db);
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
      conversation_session_id TEXT, conversation_message_id TEXT,
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
    CREATE TABLE IF NOT EXISTS entity_alias_postings(
      gram TEXT NOT NULL,entity_id TEXT NOT NULL REFERENCES entities(id),
      source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),
      surface_original TEXT NOT NULL,identity_scope TEXT NOT NULL,project_id TEXT,
      PRIMARY KEY(gram,entity_id,source_id,surface_original)
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
    CREATE TABLE IF NOT EXISTS memory_chunk_graph_refs(
      memory_chunk_id TEXT NOT NULL REFERENCES memory_chunks(memory_chunk_id),
      graph_ref_type TEXT NOT NULL,graph_ref_id TEXT NOT NULL,relation TEXT NOT NULL,
      PRIMARY KEY(memory_chunk_id,graph_ref_type,graph_ref_id,relation)
    );
    CREATE TABLE IF NOT EXISTS memory_projection_windows(
      window_ref TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES memory_projection_jobs(job_id),
      ordinal INTEGER NOT NULL, source_refs_json TEXT NOT NULL, output_json TEXT, normalized_plan_json TEXT,
      provider_evidence_json TEXT, state TEXT NOT NULL, error_code TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,owner_pid INTEGER,owner_nonce TEXT,started_at TEXT,
      input_json TEXT,input_sha256 TEXT,input_migration_note TEXT,parent_window_ref TEXT,replaced_by_json TEXT,
      UNIQUE(job_id,ordinal)
    );
    CREATE TABLE IF NOT EXISTS memory_hot_cache_outcomes(
      entry_id TEXT PRIMARY KEY, generation TEXT NOT NULL, admitted INTEGER NOT NULL,
      reason TEXT, receipt_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_projection_attempts(
      attempt_ref TEXT PRIMARY KEY,window_ref TEXT NOT NULL,job_id TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,state TEXT NOT NULL,error_code TEXT,
      input_sha256 TEXT,output_json TEXT,provider_evidence_json TEXT,recorded_at TEXT NOT NULL,
      attempt_kind TEXT NOT NULL DEFAULT 'provider',provider_invoked INTEGER NOT NULL DEFAULT 0,
      outcome_known INTEGER NOT NULL DEFAULT 1,invocation_ref TEXT,
      UNIQUE(window_ref,attempt_count,state)
    );
    CREATE TABLE IF NOT EXISTS memory_source_split_parents(
      source_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL,revision TEXT NOT NULL,source_kind TEXT NOT NULL,
      conversation_session_id TEXT,conversation_message_id TEXT,part_id TEXT NOT NULL,
      scalar_pointer TEXT NOT NULL,byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,content_hash TEXT NOT NULL,
      role TEXT NOT NULL,origin_kind TEXT NOT NULL,observed_at TEXT NOT NULL,basis TEXT NOT NULL,
      child_source_ids_json TEXT NOT NULL,recorded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_vector_units(
      unit_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES memory_projection_jobs(job_id),
      record_kind TEXT NOT NULL,owner_id TEXT NOT NULL,owner_revision TEXT NOT NULL,
      project_id TEXT,origin_kind TEXT NOT NULL,projection_text TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',error_code TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,owner_pid INTEGER,owner_nonce TEXT,started_at TEXT,
      receipt_json TEXT,
      source_ids_json TEXT,source_byte_start INTEGER,source_byte_end INTEGER,source_role TEXT,
      UNIQUE(job_id,record_kind,owner_id,owner_revision,project_id,origin_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_alias_nfc ON entity_aliases(nfc_key,entity_id);
    CREATE INDEX IF NOT EXISTS idx_alias_folded ON entity_aliases(folded_key,entity_id);
    CREATE INDEX IF NOT EXISTS idx_edges_source_rel ON edges(source_node_id,rel_type);
    CREATE INDEX IF NOT EXISTS idx_edges_target_rel ON edges(target_node_id,rel_type);
    CREATE INDEX IF NOT EXISTS idx_mentions_entity_episode ON entity_mentions(entity_id,episode_id);
    CREATE INDEX IF NOT EXISTS idx_sources_message_revision ON memory_chunk_sources(conversation_message_id,revision);
    CREATE INDEX IF NOT EXISTS idx_chunks_project_origin ON memory_chunks(project_id,origin_kind,conversation_start,memory_chunk_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_state ON memory_projection_jobs(last_served_at,created_at,job_id);
    CREATE INDEX IF NOT EXISTS idx_vector_units_state ON memory_vector_units(state,job_id,record_kind,unit_id);
  `);
  ensureColumn(db, "memory_projection_jobs", "hot_cache_receipt_json", "TEXT");
  ensureColumn(db, "memory_projection_jobs", "identity_decisions_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "entities", "identity_history_job_id", "TEXT REFERENCES memory_projection_jobs(job_id)");
  ensureColumn(db, "entities", "identity_history_ref", "TEXT");
  ensureColumn(db, "memory_projection_jobs", "hot_cache_attempt_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "memory_projection_jobs", "hot_cache_next_attempt_at", "TEXT");
  ensureColumn(db, "memory_projection_jobs", "hot_cache_owner_pid", "INTEGER");
  ensureColumn(db, "memory_projection_jobs", "hot_cache_owner_nonce", "TEXT");
  ensureColumn(db, "memory_projection_jobs", "hot_cache_started_at", "TEXT");
  for (const [table, name, declaration] of [
    ["memory_projection_windows", "attempt_count", "INTEGER NOT NULL DEFAULT 0"],
    ["memory_projection_windows", "next_attempt_at", "TEXT"],
    ["memory_projection_windows", "owner_pid", "INTEGER"],
    ["memory_projection_windows", "owner_nonce", "TEXT"],
    ["memory_projection_windows", "started_at", "TEXT"],
    ["memory_projection_windows", "input_json", "TEXT"],
    ["memory_projection_windows", "input_sha256", "TEXT"],
    ["memory_projection_windows", "input_migration_note", "TEXT"],
    ["memory_projection_windows", "parent_window_ref", "TEXT"],
    ["memory_projection_windows", "replaced_by_json", "TEXT"],
    ["memory_projection_windows", "recovery_revision", "TEXT"],
    ["memory_projection_windows", "recovery_base_attempt_count", "INTEGER NOT NULL DEFAULT 0"],
    ["memory_projection_attempts", "recovery_revision", "TEXT"],
    ["memory_projection_attempts", "recovery_request_json", "TEXT"],
    ["memory_projection_attempts", "attempt_kind", "TEXT NOT NULL DEFAULT 'provider'"],
    ["memory_projection_attempts", "provider_invoked", "INTEGER NOT NULL DEFAULT 0"],
    ["memory_projection_attempts", "outcome_known", "INTEGER NOT NULL DEFAULT 1"],
    ["memory_projection_attempts", "invocation_ref", "TEXT"],
    ["memory_vector_units", "attempt_count", "INTEGER NOT NULL DEFAULT 0"],
    ["memory_vector_units", "next_attempt_at", "TEXT"],
    ["memory_vector_units", "owner_pid", "INTEGER"],
    ["memory_vector_units", "owner_nonce", "TEXT"],
    ["memory_vector_units", "started_at", "TEXT"],
    ["memory_vector_units", "receipt_json", "TEXT"],
    ["memory_vector_units", "provider_invoked", "INTEGER NOT NULL DEFAULT 0"],
    ["memory_vector_units", "outcome_known", "INTEGER NOT NULL DEFAULT 1"],
    ["memory_vector_units", "invocation_ref", "TEXT"],
    ["memory_vector_units", "source_ids_json", "TEXT"],
    ["memory_vector_units", "source_byte_start", "INTEGER"],
    ["memory_vector_units", "source_byte_end", "INTEGER"],
    ["memory_vector_units", "source_role", "TEXT"],
  ] as const) ensureColumn(db, table, name, declaration);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_windows_due ON memory_projection_windows(state,next_attempt_at,job_id,ordinal);
    CREATE INDEX IF NOT EXISTS idx_vector_units_due ON memory_vector_units(state,next_attempt_at,job_id,record_kind,unit_id);
    CREATE INDEX IF NOT EXISTS idx_memory_chunk_graph_refs_ref ON memory_chunk_graph_refs(graph_ref_type,graph_ref_id);
  `);
  const legacyMigration = db.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='t3_legacy_failure_migration'").get();
  if (!legacyMigration) db.transaction(() => {
    const now = new Date().toISOString();
    db.query(`UPDATE memory_projection_windows SET attempt_count=1
      WHERE state='failed' AND attempt_count=0 AND input_json IS NULL AND input_migration_note IS NULL AND normalized_plan_json IS NULL`).run();
    db.query(`INSERT OR IGNORE INTO memory_projection_attempts
      (attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,output_json,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known)
      SELECT window_ref || ':attempt:1:failed',window_ref,job_id,1,'failed',error_code,input_sha256,output_json,provider_evidence_json,COALESCE(started_at,?),'legacy',1,1
      FROM memory_projection_windows WHERE state='failed' AND attempt_count=1 AND input_json IS NULL AND input_migration_note IS NULL AND normalized_plan_json IS NULL`).run(now);
    db.query(`UPDATE memory_projection_windows
      SET state='pending',next_attempt_at=?,input_migration_note='legacy_input_unavailable'
      WHERE state='failed' AND attempt_count=1 AND input_json IS NULL AND input_migration_note IS NULL AND normalized_plan_json IS NULL`).run(now);
    db.query("INSERT INTO memory_state(key,value) VALUES('t3_legacy_failure_migration',?)").run(now);
  })();
}

function migrateNullableCanonicalSourceIds(db: Database): void {
  if (db.inTransaction) return;
  const needsMigration = (table: string) => {
    const columns = db.query<{ name: string; notnull: number }, []>(
      `PRAGMA table_info(${table})`,
    ).all();
    return columns.length > 0 && columns.some(
      (column) => (column.name === "conversation_session_id" ||
        column.name === "conversation_message_id") && column.notnull === 1,
    );
  };
  const migrateSources = needsMigration("memory_chunk_sources");
  const migrateParents = needsMigration("memory_source_split_parents");
  if (!migrateSources && !migrateParents) return;
  db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON");
  try {
    db.transaction(() => {
      if (migrateSources) {
        db.exec(`
          DROP INDEX IF EXISTS idx_sources_message_revision;
          ALTER TABLE memory_chunk_sources RENAME TO memory_chunk_sources_pre_t5a;
          CREATE TABLE memory_chunk_sources(
            source_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL REFERENCES memory_chunks(memory_chunk_id),
            revision TEXT NOT NULL,source_kind TEXT NOT NULL,conversation_session_id TEXT,
            conversation_message_id TEXT,part_id TEXT NOT NULL,scalar_pointer TEXT NOT NULL,
            byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,content_hash TEXT NOT NULL,
            role TEXT NOT NULL,origin_kind TEXT NOT NULL,observed_at TEXT NOT NULL,basis TEXT NOT NULL,
            UNIQUE(episode_id,revision,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end)
          );
          INSERT INTO memory_chunk_sources SELECT * FROM memory_chunk_sources_pre_t5a;
          DROP TABLE memory_chunk_sources_pre_t5a;
        `);
      }
      if (migrateParents) {
        db.exec(`
          ALTER TABLE memory_source_split_parents RENAME TO memory_source_split_parents_pre_t5a;
          CREATE TABLE memory_source_split_parents(
            source_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL,revision TEXT NOT NULL,source_kind TEXT NOT NULL,
            conversation_session_id TEXT,conversation_message_id TEXT,part_id TEXT NOT NULL,
            scalar_pointer TEXT NOT NULL,byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,
            content_hash TEXT NOT NULL,role TEXT NOT NULL,origin_kind TEXT NOT NULL,observed_at TEXT NOT NULL,
            basis TEXT NOT NULL,child_source_ids_json TEXT NOT NULL,recorded_at TEXT NOT NULL
          );
          INSERT INTO memory_source_split_parents SELECT * FROM memory_source_split_parents_pre_t5a;
          DROP TABLE memory_source_split_parents_pre_t5a;
        `);
      }
    })();
  } finally {
    db.exec("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON");
  }
}

function ensureColumn(db: Database, table: string, name: string, declaration: string): void {
  const found = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((row) => row.name === name);
  if (!found) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
}

export function installAndBackfillRecallIndexes(db: Database): void {
  const postingColumns = db.query<{ name: string }, []>("PRAGMA table_info(entity_alias_postings)").all().map((row) => row.name);
  if (postingColumns.length > 0 && !postingColumns.includes("surface_original")) db.exec("DROP TABLE entity_alias_postings");
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_alias_postings(
      gram TEXT NOT NULL,entity_id TEXT NOT NULL REFERENCES entities(id),
      source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),
      surface_original TEXT NOT NULL,identity_scope TEXT NOT NULL,project_id TEXT,
      PRIMARY KEY(gram,entity_id,source_id,surface_original)
    );
    CREATE INDEX IF NOT EXISTS idx_alias_postings_entity ON entity_alias_postings(entity_id,gram,source_id,surface_original);
    CREATE INDEX IF NOT EXISTS idx_alias_postings_scope_gram_node ON entity_alias_postings(identity_scope,project_id,gram,entity_id);
    CREATE TABLE IF NOT EXISTS memory_vector_units(
      unit_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES memory_projection_jobs(job_id),
      record_kind TEXT NOT NULL,owner_id TEXT NOT NULL,owner_revision TEXT NOT NULL,
      project_id TEXT,origin_kind TEXT NOT NULL,projection_text TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',error_code TEXT,
      UNIQUE(job_id,record_kind,owner_id,owner_revision,project_id,origin_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_vector_units_state ON memory_vector_units(state,job_id,record_kind,unit_id);
  `);
  for (const [name, declaration] of [
    ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
    ["next_attempt_at", "TEXT"],
    ["owner_pid", "INTEGER"],
    ["owner_nonce", "TEXT"],
    ["started_at", "TEXT"],
    ["receipt_json", "TEXT"],
  ] as const) ensureColumn(db, "memory_vector_units", name, declaration);
  const rows = db.query<{ entity_id: string; source_id: string; surface_original: string; folded_key: string; identity_scope: string; project_id: string | null }, []>(`
    SELECT a.entity_id,a.source_id,a.surface_original,a.folded_key,e.identity_scope,e.project_id FROM entity_aliases a JOIN entities e ON e.id=a.entity_id
    ORDER BY a.entity_id,a.source_id,a.surface_original
  `).all();
  const insert = db.query("INSERT OR IGNORE INTO entity_alias_postings(gram,entity_id,source_id,surface_original,identity_scope,project_id) VALUES(?,?,?,?,?,?)");
  db.transaction(() => {
    for (const row of rows) for (const gram of foldedGraphemeNgrams(row.folded_key))
      insert.run(gram, row.entity_id, row.source_id, row.surface_original, row.identity_scope, row.project_id);
  })();
}

function foldedGraphemeNgrams(value: string): string[] {
  const graphemes = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)].map((item) => item.segment);
  const grams: string[] = [];
  for (const size of [2, 3]) for (let index = 0; index + size <= graphemes.length; index += 1) grams.push(graphemes.slice(index, index + size).join(""));
  return [...new Set(grams)];
}

export type ClaimedVectorUnit = {
  unit_id: string;
  job_id: string;
  record_kind: "node" | "episode";
  owner_id: string;
  owner_revision: string;
  project_id: string | null;
  origin_kind: string;
  projection_text: string;
  source_revision: string;
  conversation_session_id: string | null;
  source_kind: string;
  source_observed_at: string;
  source_ids_json: string;
  receipt_json: string | null;
  attempt_count: number;
  owner_nonce: string;
};

export function refreshVectorUnitsForJob(db: Database, jobId: string, episodeProjectionText: string | Array<{ sourceId: string; text: string; role: string; byteStart: number }>): void {
  const job = db.query<{ episode_id: string; revision: string }, [string]>("SELECT episode_id,revision FROM memory_projection_jobs WHERE job_id=?").get(jobId);
  if (!job) throw new Error("memory_projection_job_not_found");
  const chunk = db.query<{ project_id: string | null; origin_kind: string; summary: string }, [string, string]>("SELECT project_id,origin_kind,summary FROM memory_chunks WHERE memory_chunk_id=? AND current_revision=?").get(job.episode_id, job.revision);
  if (!chunk) throw new Error("memory_source_changed");
  const nodes = db.query<{ id: string; type: string; label_original: string; properties: string; origin_kind: string }, [string, string]>(`
    SELECT e.id,e.type,e.label_original,e.properties,s.origin_kind
    FROM entities e JOIN entity_mentions m ON m.entity_id=e.id
    JOIN memory_chunk_sources s ON s.source_id=m.source_id
    WHERE m.episode_id=? AND m.revision=? GROUP BY e.id,s.origin_kind ORDER BY e.id,s.origin_kind
  `).all(job.episode_id, job.revision);
  let activeStage: "node" | "episode" = "node";
  try { db.transaction(() => {
    const desiredNodeUnits = new Set<string>();
    for (const node of nodes) {
      const aliases = db.query<{ surface_original: string }, [string, string, string, string]>(`
        SELECT DISTINCT a.surface_original FROM entity_aliases a JOIN memory_chunk_sources s ON s.source_id=a.source_id
        WHERE a.entity_id=? AND s.episode_id=? AND s.revision=? AND s.origin_kind=? ORDER BY a.surface_original LIMIT 8
      `).all(node.id, job.episode_id, job.revision, node.origin_kind).map((row) => row.surface_original);
      const scopedLabel = aliases[0] ?? (node.type === "entity" || node.type === "project" ? "" : node.label_original);
      const claim = projectionClaimFields(node.properties);
      const projection = [
        `type:${JSON.stringify(node.type)}`,
        `label:${JSON.stringify(scopedLabel)}`,
        `statement:${JSON.stringify(claim.statement)}`,
        `condition:${JSON.stringify(claim.condition)}`,
        `polarity:${JSON.stringify(claim.polarity)}`,
        ...aliases.map((alias) => `alias:${JSON.stringify(alias)}`),
      ].join("\n");
      const revision = projectionDigest(["node-vector", node.id, chunk.project_id, node.origin_kind, projection]);
      const sourceIds = db.query<{ source_id: string }, [string, string, string, string]>(`
        SELECT DISTINCT m.source_id FROM entity_mentions m JOIN memory_chunk_sources s ON s.source_id=m.source_id
        WHERE m.entity_id=? AND m.episode_id=? AND m.revision=? AND s.origin_kind=? ORDER BY m.source_id
      `).all(node.id, job.episode_id, job.revision, node.origin_kind).map((row) => row.source_id);
      try {
        for (const [ordinal, text] of projectionChunks(projection).entries()) {
          const chunkRevision = projectionDigest(["node-vector-chunk", revision, ordinal, text]);
          const unitId = projectionDigest(["vector-unit", jobId, "node", node.id, chunkRevision]);
          desiredNodeUnits.add(unitId);
          db.query("INSERT OR IGNORE INTO memory_vector_units(unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,source_ids_json) VALUES(?,?,?,?,?,?,?,?,?)")
            .run(unitId, jobId, "node", node.id, chunkRevision, chunk.project_id, node.origin_kind, text, JSON.stringify(sourceIds));
          retainReusableVectorReceipt(db, unitId, "node", node.id, chunkRevision, chunk.project_id, node.origin_kind);
        }
      } catch (error) {
        if (!(error instanceof Error && error.message === "memory_vector_oversized_grapheme")) throw error;
        const chunkRevision = projectionDigest(["node-vector-oversized", revision]);
        const unitId = projectionDigest(["vector-unit", jobId, "node", node.id, chunkRevision]);
        desiredNodeUnits.add(unitId);
        db.query(`INSERT OR IGNORE INTO memory_vector_units
          (unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,state,error_code,source_ids_json)
          VALUES(?,?,?,?,?,?,?,'','failed','memory_vector_oversized_grapheme',?)`)
          .run(unitId, jobId, "node", node.id, chunkRevision, chunk.project_id, node.origin_kind, JSON.stringify(sourceIds));
      }
    }
    activeStage = "episode";
    const sources = db.query<{ role: string; source_id: string }, [string, string]>("SELECT role,source_id FROM memory_chunk_sources WHERE episode_id=? AND revision=? ORDER BY observed_at,conversation_message_id,part_id,scalar_pointer,byte_start").all(job.episode_id, job.revision);
    const episodeInputs = typeof episodeProjectionText === "string"
      ? [{ sourceId: sources.map((row) => row.source_id).join("\0"), text: episodeProjectionText, role: "mixed", byteStart: 0 }]
      : episodeProjectionText;
    const desiredEpisodeUnits = new Set<string>();
    for (const source of episodeInputs) {
      let byteStart = source.byteStart;
      try {
        for (const text of projectionChunks(source.text, 4000)) {
          const byteEnd = byteStart + Buffer.byteLength(text);
          const chunkRevision = projectionDigest(["episode-vector-chunk", job.episode_id, job.revision, source.sourceId, byteStart, byteEnd, text]);
          const unitId = projectionDigest(["vector-unit", jobId, "episode", job.episode_id, chunkRevision]);
          desiredEpisodeUnits.add(unitId);
          db.query("INSERT OR IGNORE INTO memory_vector_units(unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,source_ids_json,source_byte_start,source_byte_end,source_role) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(unitId, jobId, "episode", job.episode_id, chunkRevision, chunk.project_id, chunk.origin_kind,
              `[${source.role}] ${text}`, JSON.stringify(source.sourceId.includes("\0") ? source.sourceId.split("\0") : [source.sourceId]), byteStart, byteEnd, source.role);
          byteStart = byteEnd;
        }
      } catch (error) {
        if (!(error instanceof Error && error.message === "memory_vector_oversized_grapheme")) throw error;
        const chunkRevision = projectionDigest(["episode-vector-oversized", job.episode_id, job.revision, source.sourceId, source.byteStart]);
        const unitId = projectionDigest(["vector-unit", jobId, "episode", job.episode_id, chunkRevision]);
        desiredEpisodeUnits.add(unitId);
        db.query(`INSERT OR IGNORE INTO memory_vector_units
          (unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,state,error_code,source_ids_json,source_byte_start,source_byte_end,source_role)
          VALUES(?,?,?,?,?,?,?,'','failed','memory_vector_oversized_grapheme',?,?,?,?)`)
          .run(unitId, jobId, "episode", job.episode_id, chunkRevision, chunk.project_id, chunk.origin_kind,
            JSON.stringify(source.sourceId.includes("\0") ? source.sourceId.split("\0") : [source.sourceId]), source.byteStart, source.byteStart + Buffer.byteLength(source.text), source.role);
      }
    }
    supersedeObsoleteVectorUnits(db, jobId, "node", desiredNodeUnits);
    supersedeObsoleteVectorUnits(db, jobId, "episode", desiredEpisodeUnits);
    refreshVectorStageStates(db, jobId);
  })(); } catch (error) {
    throw new VectorRegistrationError(activeStage, error);
  }
}

class VectorRegistrationError extends Error {
  constructor(readonly stage: "node" | "episode", cause: unknown) {
    super(cause instanceof Error ? cause.message : "memory_vector_registration_failed", { cause });
    this.name = "VectorRegistrationError";
  }
}

export function vectorRegistrationFailureStage(error: unknown): "node" | "episode" | null {
  return error instanceof VectorRegistrationError ? error.stage : null;
}

function retainReusableVectorReceipt(
  db: Database,
  unitId: string,
  kind: "node" | "episode",
  ownerId: string,
  ownerRevision: string,
  projectId: string | null,
  originKind: string,
): void {
  const prior = db.query<{ receipt_json: string }, [string, string, string, string | null, string, string]>(`
    SELECT receipt_json FROM memory_vector_units
    WHERE record_kind=? AND owner_id=? AND owner_revision=? AND project_id IS ? AND origin_kind=?
      AND state='complete' AND unit_id!=? AND receipt_json IS NOT NULL ORDER BY unit_id LIMIT 1
  `).get(kind, ownerId, ownerRevision, projectId, originKind, unitId);
  if (prior) db.query("UPDATE memory_vector_units SET receipt_json=?,error_code='memory_vector_reuse_pending' WHERE unit_id=? AND state='pending'")
    .run(prior.receipt_json, unitId);
}

function supersedeObsoleteVectorUnits(db: Database, jobId: string, kind: "node" | "episode", desired: Set<string>): void {
  for (const row of db.query<{ unit_id: string }, [string, string]>("SELECT unit_id FROM memory_vector_units WHERE job_id=? AND record_kind=? AND state!='superseded'").all(jobId, kind)) {
    if (!desired.has(row.unit_id)) db.query("UPDATE memory_vector_units SET state='superseded',owner_pid=NULL,owner_nonce=NULL,started_at=NULL WHERE unit_id=?").run(row.unit_id);
  }
}

export function claimNextVectorQuantum(
  db: Database,
  input: { jobId?: string; kind?: "node" | "episode"; now?: string; ownerPid?: number; ownerNonce?: string; isOwnerActive?: (jobId: string, unitId: string, ownerNonce: string) => boolean } = {},
): ClaimedVectorUnit[] {
  return db.transaction(() => {
    const now = input.now ?? new Date().toISOString();
    recoverInterruptedVectorUnits(db, input.ownerPid ?? process.pid, input.isOwnerActive);
    const rows = db.query<ClaimedVectorUnit, []>(`
      SELECT u.*,j.revision source_revision,c.conversation_session_id,
        (SELECT ordered.source_kind FROM memory_chunk_sources ordered
          WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision
          ORDER BY ordered.source_id LIMIT 1) source_kind,
        (SELECT ordered.observed_at FROM memory_chunk_sources ordered
          WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision
            AND (u.source_ids_json IS NULL OR ordered.source_id IN (SELECT value FROM json_each(u.source_ids_json)))
            AND (u.record_kind='episode' OR (ordered.origin_kind=u.origin_kind AND EXISTS(SELECT 1 FROM entity_mentions own WHERE own.source_id=ordered.source_id AND own.entity_id=u.owner_id)))
          ORDER BY julianday(ordered.observed_at) DESC,ordered.source_id DESC LIMIT 1) source_observed_at,
        COALESCE(u.source_ids_json,(SELECT json_group_array(source_id) FROM (SELECT source_id FROM memory_chunk_sources ordered
          WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision
            AND (u.record_kind='episode' OR (ordered.origin_kind=u.origin_kind AND EXISTS(SELECT 1 FROM entity_mentions own WHERE own.source_id=ordered.source_id AND own.entity_id=u.owner_id)))
          ORDER BY julianday(ordered.observed_at),ordered.conversation_message_id,ordered.part_id,ordered.scalar_pointer,ordered.byte_start))) source_ids_json
      FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id
      JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
      WHERE u.state='pending' AND (u.next_attempt_at IS NULL OR u.next_attempt_at<=${sqlLiteral(now)})
        ${input.jobId ? `AND u.job_id=${sqlLiteral(input.jobId)}` : ""}
        ${input.kind ? `AND u.record_kind=${sqlLiteral(input.kind)}` : ""}
      ORDER BY j.last_served_at IS NOT NULL,j.last_served_at,j.created_at,j.job_id,u.unit_id LIMIT 4
    `).all();
    const nonce = input.ownerNonce ?? randomUUID();
    for (const row of rows) {
      db.query("UPDATE memory_vector_units SET state='running',error_code=NULL,attempt_count=attempt_count+1,owner_pid=?,owner_nonce=?,started_at=?,next_attempt_at=NULL,provider_invoked=0,outcome_known=1,invocation_ref=NULL WHERE unit_id=? AND state='pending'")
        .run(input.ownerPid ?? process.pid, nonce, now, row.unit_id);
      row.attempt_count = Number(row.attempt_count ?? 0) + 1;
      row.owner_nonce = nonce;
    }
    if (rows[0]) {
      const column = rows[0].record_kind === "node" ? "node_vectors_state" : "episode_vectors_state";
      db.query(`UPDATE memory_projection_jobs SET ${column}=? WHERE job_id=?`).run(JSON.stringify({ state: "running", attempt: rows[0].attempt_count, owner_pid: input.ownerPid ?? process.pid, started_at: now }), rows[0].job_id);
    }
    return rows;
  })();
}

export function completeVectorQuantum(db: Database, units: ClaimedVectorUnit[], receipt?: unknown): void {
  db.transaction(() => {
    for (const unit of units) db.query("UPDATE memory_vector_units SET state='complete',error_code=NULL,owner_pid=NULL,owner_nonce=NULL,started_at=NULL,receipt_json=?,outcome_known=1 WHERE unit_id=? AND owner_nonce=?").run(receipt ? JSON.stringify(receipt) : null, unit.unit_id, unit.owner_nonce);
    for (const jobId of new Set(units.map((unit) => unit.job_id))) refreshVectorStageStates(db, jobId);
  })();
}

export function recordVectorInvocationStarted(db: Database, units: ClaimedVectorUnit[]): void {
  for (const unit of units) {
    const changed = db.query("UPDATE memory_vector_units SET provider_invoked=1,outcome_known=0,invocation_ref=? WHERE unit_id=? AND state='running' AND owner_nonce=?")
      .run(unit.owner_nonce, unit.unit_id, unit.owner_nonce);
    if (changed.changes !== 1) throw new Error("memory_vector_unit_changed");
  }
}

export function failVectorQuantum(db: Database, units: ClaimedVectorUnit[], code: string, retryAt: string | null = null): void {
  db.transaction(() => {
    for (const unit of units) {
      const retry = retryAt && unit.attempt_count < 3;
      db.query("UPDATE memory_vector_units SET state=?,error_code=?,next_attempt_at=?,owner_pid=NULL,owner_nonce=NULL,started_at=NULL,outcome_known=1 WHERE unit_id=? AND owner_nonce=?")
        .run(retry ? "pending" : "failed", code, retry ? retryAt : null, unit.unit_id, unit.owner_nonce);
    }
    for (const jobId of new Set(units.map((unit) => unit.job_id))) refreshVectorStageStates(db, jobId);
  })();
}

export function markVectorRegistrationFailure(
  db: Database,
  jobId: string,
  code: string,
  stage: "node" | "episode" | null,
): void {
  if (!stage) throw new Error("memory_vector_registration_stage_unknown");
  const column = stage === "node" ? "node_vectors_state" : "episode_vectors_state";
  const current = JSON.parse(db.query<{ state: string }, [string]>(`SELECT ${column} state FROM memory_projection_jobs WHERE job_id=?`).get(jobId)?.state ?? "null") as StageState | null;
  if (!current || current.state === "complete" || current.state === "not_configured") return;
  const retryable = code === "memory_write_busy";
  const state = retryable
    ? { state: "pending", blocked_by: code }
    : { state: "failed", code, retryable: false, next_attempt_at: null };
  db.query(`UPDATE memory_projection_jobs SET ${column}=? WHERE job_id=?`).run(JSON.stringify(state), jobId);
}

function projectionChunks(text: string, maxBytes = 4096): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const item of new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)) {
    if (Buffer.byteLength(item.segment) > maxBytes) throw new Error("memory_vector_oversized_grapheme");
    if (current && Buffer.byteLength(current + item.segment) > maxBytes) {
      chunks.push(current);
      current = item.segment;
    } else current += item.segment;
  }
  if (current) chunks.push(current);
  return chunks;
}

function recoverInterruptedVectorUnits(
  db: Database,
  currentPid: number,
  isOwnerActive?: (jobId: string, unitId: string, ownerNonce: string) => boolean,
): void {
  const jobs = new Set<string>();
  for (const row of db.query<{ unit_id: string; job_id: string; owner_pid: number | null; owner_nonce: string | null }, []>("SELECT unit_id,job_id,owner_pid,owner_nonce FROM memory_vector_units WHERE state='running'").all()) {
    const abandonedHere = row.owner_pid === currentPid && Boolean(row.owner_nonce) && !isOwnerActive?.(row.job_id, row.unit_id, row.owner_nonce!);
    const deadElsewhere = row.owner_pid !== null && row.owner_pid !== currentPid && !pidAlive(row.owner_pid);
    if (abandonedHere || deadElsewhere) {
      db.query(`UPDATE memory_vector_units SET
        state=CASE WHEN provider_invoked=1 AND outcome_known=0 THEN 'failed' ELSE 'pending' END,
        attempt_count=CASE WHEN provider_invoked=1 THEN attempt_count ELSE MAX(0,attempt_count-1) END,
        error_code=CASE WHEN provider_invoked=1 AND outcome_known=0 THEN 'memory_embedding_outcome_unknown' ELSE 'memory_projection_interrupted' END,
        next_attempt_at=NULL,owner_pid=NULL,owner_nonce=NULL,started_at=NULL
        WHERE unit_id=? AND state='running'`).run(row.unit_id);
      jobs.add(row.job_id);
    }
  }
  for (const job of jobs) refreshVectorStageStates(db, job);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function refreshVectorStageStates(db: Database, jobId: string): void {
  for (const [kind, column] of [["node", "node_vectors_state"], ["episode", "episode_vectors_state"]] as const) {
    const count = db.query<{ total: number; complete: number; failed: number }, [string, string]>("SELECT COUNT(*) total,SUM(state='complete') complete,SUM(state='failed') failed FROM memory_vector_units WHERE job_id=? AND record_kind=? AND state!='superseded'").get(jobId, kind) ?? { total: 0, complete: 0, failed: 0 };
    const total = Number(count.total), complete = Number(count.complete), failed = Number(count.failed), pending = total - complete - failed;
    const semanticState = kind === "node"
      ? JSON.parse(db.query<{ semantic_graph_state: string }, [string]>("SELECT semantic_graph_state FROM memory_projection_jobs WHERE job_id=?").get(jobId)?.semantic_graph_state ?? '{"state":"pending"}') as { state: string }
      : null;
    const state = total === 0 && kind === "node" && semanticState?.state !== "complete"
      ? { state: "pending", blocked_by: "semantic_graph" }
      : failed || (complete && pending) ? { state: "partial", completed_units: complete, total_units: total, pending_units: pending, failed_units: failed }
      : complete === total ? { state: "complete", completed_units: complete, total_units: total }
      : { state: "pending", blocked_by: null };
    db.query(`UPDATE memory_projection_jobs SET ${column}=?,last_served_at=? WHERE job_id=?`).run(JSON.stringify(state), new Date().toISOString(), jobId);
  }
}

function projectionClaimFields(properties: string): { statement: string | null; condition: string | null; polarity: string | null } {
  try {
    const value = JSON.parse(properties) as { statement?: unknown; condition?: unknown; polarity?: unknown };
    return {
      statement: typeof value.statement === "string" ? value.statement : null,
      condition: typeof value.condition === "string" ? value.condition : null,
      polarity: typeof value.polarity === "string" ? value.polarity : null,
    };
  } catch {
    return { statement: null, condition: null, polarity: null };
  }
}

function projectionDigest(value: unknown[]): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
}

export function progressFromDb(db: Database, jobId: string): MemoryJobProgress {
  const row = db
    .query<
      Record<string, string>,
      [string]
    >("SELECT j.*,c.current_revision FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE j.job_id=?")
    .get(jobId);
  if (!row) throw new Error("memory_projection_job_not_found");
  const source = JSON.parse(row.source_state) as StageState;
  const semantic = JSON.parse(row.semantic_graph_state) as StageState;
  const episodeVectors = JSON.parse(row.episode_vectors_state) as StageState;
  const nodeVectors = JSON.parse(row.node_vectors_state) as StageState;
  const hotCache = JSON.parse(row.hot_cache_state) as StageState;
  const states = [source, semantic, episodeVectors, nodeVectors, hotCache];
  const outcome = row.current_revision !== row.revision
    ? "superseded"
    : states.every((state) => state.state === "complete")
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
  attemptCount: number;
  recoveryAttemptCount: number;
  ownerNonce: string;
  pinnedInput: unknown | null;
  inputMigrationNote: string | null;
};

function providerAttemptCount(db: Database, windowRef: string, recoveryRevision: string | null): number {
  return Number(db.query<{ count: number }, [string, string | null]>(
    "SELECT COUNT(DISTINCT invocation_ref) count FROM memory_projection_attempts WHERE window_ref=? AND provider_invoked=1 AND recovery_revision IS ?",
  ).get(windowRef, recoveryRevision)?.count ?? 0);
}

export function claimNextProjectionWindow(
  db: Database,
  input: { jobId?: string; now?: string; ownerPid?: number; ownerNonce?: string; isOwnerActive?: (jobId: string, windowRef: string, ownerNonce: string) => boolean } = {},
): ClaimedProjectionWindow | null {
  return db.transaction(() => {
    const now = input.now ?? new Date().toISOString();
    recoverInterruptedWindows(db, input.ownerPid ?? process.pid, input.isOwnerActive);
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
          attempt_count: number;
          recovery_base_attempt_count: number;
          recovery_revision: string | null;
          input_json: string | null;
          input_migration_note: string | null;
        },
        []
      >(
        `
    SELECT w.job_id,w.window_ref,w.source_refs_json,j.extraction_model,j.reasoning_effort,
           w.state,w.output_json,w.normalized_plan_json,w.attempt_count,w.recovery_base_attempt_count,w.recovery_revision,w.input_json,w.input_migration_note
    FROM memory_projection_windows w
    JOIN memory_projection_jobs j ON j.job_id=w.job_id
    WHERE w.state IN ('pending','planned')
      AND w.owner_nonce IS NULL
      AND (w.state='planned' OR w.output_json IS NOT NULL OR
        (SELECT COUNT(DISTINCT a.invocation_ref) FROM memory_projection_attempts a WHERE a.window_ref=w.window_ref AND a.provider_invoked=1 AND a.recovery_revision IS w.recovery_revision)<3)
      AND (w.next_attempt_at IS NULL OR w.next_attempt_at<=${sqlLiteral(now)})
      ${input.jobId ? `AND w.job_id=${sqlLiteral(input.jobId)}` : ""}
    ORDER BY j.last_served_at IS NOT NULL,j.last_served_at,j.created_at,j.job_id,w.ordinal LIMIT 1
    `,
      )
      .get();
    if (!row) return null;
    const nonce = input.ownerNonce ?? randomUUID();
    db.query(
      "UPDATE memory_projection_windows SET state='running',attempt_count=attempt_count+1,owner_pid=?,owner_nonce=?,started_at=?,next_attempt_at=NULL WHERE window_ref=? AND state=?",
    ).run(input.ownerPid ?? process.pid, nonce, now, row.window_ref, row.state);
    db.query("UPDATE memory_projection_jobs SET semantic_graph_state=? WHERE job_id=?")
      .run(JSON.stringify({ state: "running", attempt: Number(row.attempt_count) + 1 - row.recovery_base_attempt_count, owner_pid: input.ownerPid ?? process.pid, started_at: now }), row.job_id);
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
      attemptCount: Number(row.attempt_count) + 1,
      recoveryAttemptCount: providerAttemptCount(db, row.window_ref, row.recovery_revision),
      ownerNonce: nonce,
      pinnedInput: row.input_json ? JSON.parse(row.input_json) : null,
      inputMigrationNote: row.input_migration_note,
    };
  })();
}

export function pinWindowInput(
  db: Database,
  windowRef: string,
  ownerNonce: string,
  input: unknown,
  migrationNote: string | null,
): void {
  const json = JSON.stringify(input);
  const sha = projectionDigest(["extract-input", json]);
  const result = db.query(`UPDATE memory_projection_windows
    SET input_json=COALESCE(input_json,?),input_sha256=COALESCE(input_sha256,?),input_migration_note=COALESCE(input_migration_note,?)
    WHERE window_ref=? AND state='running' AND owner_nonce=?`).run(json, sha, migrationNote, windowRef, ownerNonce);
  if (result.changes !== 1) throw new Error("memory_projection_window_changed");
}

export function markWindowFailure(
  db: Database,
  jobId: string,
  windowRef: string,
  code: string,
  input: { retryAt?: string | null; ownerNonce?: string; attemptKind?: "provider" | "pre_provider" | "validation"; providerInvoked?: boolean; clearResult?: boolean; failureEvidence?: unknown } = {},
): void {
  db.transaction(() => {
    const attempt = recordWindowAttemptFailure(db, jobId, windowRef, code, input);
    const retry = Boolean(input.retryAt && attempt < 3);
    const statement = db.query(`UPDATE memory_projection_windows SET state=?,error_code=?,next_attempt_at=?,owner_pid=NULL,owner_nonce=NULL,started_at=NULL
      WHERE window_ref=? ${input.ownerNonce ? "AND owner_nonce=?" : ""}`);
    if (input.ownerNonce) statement.run(retry ? "pending" : "failed", code, retry ? input.retryAt! : null, windowRef, input.ownerNonce);
    else statement.run(retry ? "pending" : "failed", code, retry ? input.retryAt! : null, windowRef);
    refreshSemanticState(db, jobId);
  })();
}

export function recordWindowAttemptFailure(
  db: Database,
  jobId: string,
  windowRef: string,
  code: string,
  input: { ownerNonce?: string; attemptKind?: "provider" | "pre_provider" | "validation"; providerInvoked?: boolean; clearResult?: boolean; failureEvidence?: unknown } = {},
): number {
  const row = db.query<{ attempt_count: number; recovery_revision: string | null; recovery_base_attempt_count: number; input_sha256: string | null; output_json: string | null; provider_evidence_json: string | null }, [string]>(
    `SELECT attempt_count,recovery_revision,recovery_base_attempt_count,input_sha256,output_json,provider_evidence_json FROM memory_projection_windows
     WHERE window_ref=? ${input.ownerNonce ? `AND owner_nonce=${sqlLiteral(input.ownerNonce)}` : ""}`,
  ).get(windowRef);
  if (!row) throw new Error("memory_projection_window_changed");
  const attempt = Number(row.attempt_count);
  const failureEvidence = input.failureEvidence !== undefined ? JSON.stringify(input.failureEvidence) : null;
  if (failureEvidence !== null && input.clearResult) db.query("UPDATE memory_projection_windows SET output_json=NULL,provider_evidence_json=? WHERE window_ref=?")
    .run(failureEvidence, windowRef);
  db.query(`INSERT OR REPLACE INTO memory_projection_attempts
    (attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,output_json,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known,invocation_ref,recovery_revision)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`${windowRef}:attempt:${attempt}:failed`, windowRef, jobId, attempt, "failed", code,
      row.input_sha256, input.clearResult ? null : row.output_json, failureEvidence ?? (input.clearResult ? null : row.provider_evidence_json),
      new Date().toISOString(), input.attemptKind ?? "provider", input.providerInvoked === false ? 0 : 1, 1,
      input.ownerNonce ?? null, row.recovery_revision);
  return providerAttemptCount(db, windowRef, row.recovery_revision);
}

export function saveValidatedPlan(
  db: Database,
  jobId: string,
  windowRef: string,
  ownerNonce: string,
  output: ExtractOutput,
  plan: unknown,
): void {
  const saved = db.query(
    "UPDATE memory_projection_windows SET output_json=?,normalized_plan_json=?,state='planned',error_code=NULL WHERE window_ref=? AND job_id=? AND state='running' AND owner_nonce=?",
  ).run(JSON.stringify(output), JSON.stringify(plan), windowRef, jobId, ownerNonce);
  if (saved.changes !== 1) throw new Error("memory_projection_window_changed");
}

export function saveAttemptResult(
  db: Database,
  windowRef: string,
  ownerNonce: string,
  output: unknown,
  providerEvidence: unknown,
): void {
  db.transaction(() => {
    const outputJson = output === undefined ? null : JSON.stringify(output);
    const evidenceJson = providerEvidence === undefined ? null : JSON.stringify(providerEvidence);
    const updated = db.query("UPDATE memory_projection_windows SET output_json=?,provider_evidence_json=? WHERE window_ref=? AND state='running' AND owner_nonce=?")
      .run(outputJson, evidenceJson, windowRef, ownerNonce);
    if (updated.changes !== 1) throw new Error("memory_projection_window_changed");
    const row = db.query<{ job_id: string; attempt_count: number; recovery_revision: string | null; recovery_base_attempt_count: number; input_sha256: string | null }, [string, string]>(
      "SELECT job_id,attempt_count,recovery_revision,recovery_base_attempt_count,input_sha256 FROM memory_projection_windows WHERE window_ref=? AND owner_nonce=?",
    ).get(windowRef, ownerNonce)!;
    db.query(`INSERT OR REPLACE INTO memory_projection_attempts
      (attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,output_json,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known,invocation_ref,recovery_revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`${windowRef}:attempt:${row.attempt_count}:provider`, windowRef, row.job_id,
        row.attempt_count, "provider_result", null, row.input_sha256, outputJson, evidenceJson, new Date().toISOString(), "provider", 1, 1, ownerNonce, row.recovery_revision);
  })();
}

export function recordProviderInvocationIntent(
  db: Database,
  windowRef: string,
  ownerNonce: string,
): void {
  const row = db.query<{ job_id: string; attempt_count: number; recovery_revision: string | null; input_sha256: string | null }, [string, string]>(
    "SELECT job_id,attempt_count,recovery_revision,input_sha256 FROM memory_projection_windows WHERE window_ref=? AND state='running' AND owner_nonce=?",
  ).get(windowRef, ownerNonce);
  if (!row) throw new Error("memory_projection_window_changed");
  db.query(`INSERT OR REPLACE INTO memory_projection_attempts
    (attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,output_json,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known,invocation_ref,recovery_revision)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`${windowRef}:attempt:${row.attempt_count}:intent`, windowRef, row.job_id,
      row.attempt_count, "invocation_intent", null, row.input_sha256, null, null, new Date().toISOString(), "provider_intent", 0, 0, ownerNonce, row.recovery_revision);
}

export function markPlannedWindowFailure(
  db: Database,
  jobId: string,
  windowRef: string,
  ownerNonce: string,
  code: string,
  retryAt: string | null,
): void {
  db.transaction(() => {
    const row = db.query<{ attempt_count: number; recovery_revision: string | null; recovery_base_attempt_count: number; input_sha256: string | null; output_json: string | null; provider_evidence_json: string | null }, [string, string]>(
      "SELECT attempt_count,recovery_revision,recovery_base_attempt_count,input_sha256,output_json,provider_evidence_json FROM memory_projection_windows WHERE window_ref=? AND owner_nonce=?",
    ).get(windowRef, ownerNonce);
    if (!row) throw new Error("memory_projection_window_changed");
    db.query(`INSERT OR REPLACE INTO memory_projection_attempts
      (attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,output_json,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known,recovery_revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`${windowRef}:attempt:${row.attempt_count}:apply-failed`, windowRef, jobId, row.attempt_count, "failed", code,
        row.input_sha256, null, null, new Date().toISOString(), "apply", 0, 1, row.recovery_revision);
    const applyAttempts = Number(db.query<{ count: number }, [string, string | null]>(
      "SELECT COUNT(*) count FROM memory_projection_attempts WHERE window_ref=? AND attempt_kind='apply' AND recovery_revision IS ?",
    ).get(windowRef, row.recovery_revision)?.count ?? 0);
    const retry = Boolean(retryAt && applyAttempts < 3);
    db.query("UPDATE memory_projection_windows SET state=?,error_code=?,next_attempt_at=?,owner_pid=NULL,owner_nonce=NULL,started_at=NULL WHERE window_ref=? AND owner_nonce=?")
      .run(retry ? "planned" : "failed", code, retry ? retryAt : null, windowRef, ownerNonce);
    refreshSemanticState(db, jobId);
  })();
}

export function invalidatePlannedWindow(
  db: Database,
  jobId: string,
  windowRef: string,
  ownerNonce: string,
  code: string,
): void {
  db.transaction(() => {
    markPlannedWindowFailure(db, jobId, windowRef, ownerNonce, code, new Date().toISOString());
    const attempt = Number(db.query<{ attempt_count: number }, [string]>(
      "SELECT attempt_count-recovery_base_attempt_count AS attempt_count FROM memory_projection_windows WHERE window_ref=?",
    ).get(windowRef)?.attempt_count ?? 0);
    db.query(`UPDATE memory_projection_windows SET state=?,input_json=NULL,input_sha256=NULL,input_migration_note=NULL,
      output_json=NULL,provider_evidence_json=NULL,normalized_plan_json=NULL,next_attempt_at=?,error_code=? WHERE window_ref=?`)
      .run(attempt >= 3 ? "failed" : "pending", attempt >= 3 ? null : new Date().toISOString(),
        attempt >= 3 ? "memory_projection_attempts_exhausted" : code, windowRef);
    refreshSemanticState(db, jobId);
  })();
}

export function splitProjectionWindow(
  db: Database,
  input: { jobId: string; windowRef: string; children: [string[], string[]]; recoveryRevision?: string | null } & (
    | { ownerNonce: string; failedTimeout?: never }
    | { ownerNonce?: never; failedTimeout: { attemptCount: number; recoveryRevision: string | null; inputSha256: string } }
  ),
): string[] {
  return db.transaction(() => {
    const parent = input.failedTimeout
      ? db.query<{ ordinal: number }, [string, string, number, string | null, string]>(
        `SELECT ordinal FROM memory_projection_windows WHERE window_ref=? AND job_id=? AND state='failed'
          AND attempt_count=? AND recovery_revision IS ? AND input_sha256=? AND normalized_plan_json IS NULL
          AND output_json IS NULL AND error_code='memory_extract_timeout'`,
      ).get(input.windowRef, input.jobId, input.failedTimeout.attemptCount, input.failedTimeout.recoveryRevision, input.failedTimeout.inputSha256)
      : db.query<{ ordinal: number }, [string, string, string]>(
      "SELECT ordinal FROM memory_projection_windows WHERE window_ref=? AND job_id=? AND owner_nonce=? AND state='running'",
    ).get(input.windowRef, input.jobId, input.ownerNonce);
    if (!parent) throw new Error("memory_projection_window_changed");
    const recoveryRevision = input.recoveryRevision !== undefined ? input.recoveryRevision
      : db.query<{ recovery_revision: string | null }, [string]>("SELECT recovery_revision FROM memory_projection_windows WHERE window_ref=?").get(input.windowRef)!.recovery_revision;
    if (input.children.some((child) => child.length === 0)) throw new Error("extraction_budget_exceeded");
    const parentSources = JSON.parse(db.query<{ source_refs_json: string }, [string]>("SELECT source_refs_json FROM memory_projection_windows WHERE window_ref=?").get(input.windowRef)!.source_refs_json) as string[];
    const flattened = input.children.flat();
    if (flattened.length !== new Set(flattened).size || JSON.stringify(flattened) !== JSON.stringify(parentSources.flatMap((sourceId) => expandSplitSourceLeaves(db, sourceId))))
      throw new Error("memory_projection_split_coverage_changed");
    const later = db.query<{ window_ref: string; ordinal: number }, [string, number]>(
      "SELECT window_ref,ordinal FROM memory_projection_windows WHERE job_id=? AND ordinal>? ORDER BY ordinal DESC",
    ).all(input.jobId, parent.ordinal);
    for (const row of later) db.query("UPDATE memory_projection_windows SET ordinal=? WHERE window_ref=?").run(row.ordinal + 1, row.window_ref);
    const parkedOrdinal = Number(db.query<{ ordinal: number }, [string]>("SELECT MIN(ordinal)-1 ordinal FROM memory_projection_windows WHERE job_id=?").get(input.jobId)?.ordinal ?? -1);
    db.query("UPDATE memory_projection_windows SET ordinal=? WHERE window_ref=?").run(parkedOrdinal, input.windowRef);
    const refs = input.children.map((child, index) => ({
      ref: projectionDigest(["memory-window-child", input.windowRef, index, ...child]),
      child,
      ordinal: parent.ordinal + index,
    }));
    for (const child of refs) db.query(`INSERT INTO memory_projection_windows
      (window_ref,job_id,ordinal,source_refs_json,state,parent_window_ref,recovery_revision) VALUES(?,?,?,?,'pending',?,?)`)
      .run(child.ref, input.jobId, child.ordinal, JSON.stringify(child.child), input.windowRef, recoveryRevision);
    db.query("UPDATE memory_projection_windows SET state='replaced',replaced_by_json=?,owner_pid=NULL,owner_nonce=NULL,started_at=NULL,next_attempt_at=NULL,error_code=? WHERE window_ref=?")
      .run(JSON.stringify(refs.map((item) => item.ref)), input.failedTimeout ? "memory_extract_timeout_split" : "memory_extract_window_split", input.windowRef);
    if (input.recoveryRevision !== undefined) db.query("UPDATE memory_projection_windows SET recovery_revision=?,recovery_base_attempt_count=attempt_count WHERE window_ref=?")
      .run(input.recoveryRevision, input.windowRef);
    refreshSemanticState(db, input.jobId);
    return refs.map((item) => item.ref);
  })();
}

export function selectNextProjectionJob(
  db: Database,
  now = new Date().toISOString(),
  isOwnerActive?: (jobId: string, windowRef: string, ownerNonce: string) => boolean,
  isVectorOwnerActive?: (jobId: string, unitId: string, ownerNonce: string) => boolean,
): { jobId: string; stage: "semantic_graph" | "node_vectors" | "hot_cache" | "episode_vectors" } | null {
  return db.transaction(() => {
    recoverInterruptedWindows(db, process.pid, isOwnerActive);
    recoverInterruptedVectorUnits(db, process.pid, isVectorOwnerActive);
    recoverInterruptedHotCache(db, process.pid);
    const jobs = db.query<{ job_id: string; next_stage: string; semantic_graph_state: string; node_vectors_state: string; hot_cache_state: string; episode_vectors_state: string }, []>(`
      SELECT j.* FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
      WHERE EXISTS(SELECT 1 FROM memory_projection_windows w WHERE w.job_id=j.job_id AND w.state IN ('pending','planned') AND w.owner_nonce IS NULL
        AND (w.state='planned' OR w.output_json IS NOT NULL OR (SELECT COUNT(DISTINCT a.invocation_ref) FROM memory_projection_attempts a WHERE a.window_ref=w.window_ref AND a.provider_invoked=1 AND a.recovery_revision IS w.recovery_revision)<3)
        AND (w.next_attempt_at IS NULL OR w.next_attempt_at<=${sqlLiteral(now)}))
         OR EXISTS(SELECT 1 FROM memory_vector_units u WHERE u.job_id=j.job_id AND u.state='pending' AND (u.next_attempt_at IS NULL OR u.next_attempt_at<=${sqlLiteral(now)}))
         OR (json_extract(j.hot_cache_state,'$.state')='pending' AND (c.summary_status='complete' OR json_extract(j.semantic_graph_state,'$.state') IN ('complete','failed') OR (json_extract(j.semantic_graph_state,'$.state')='partial' AND COALESCE(json_extract(j.semantic_graph_state,'$.pending_units'),0)=0)) AND (j.hot_cache_next_attempt_at IS NULL OR j.hot_cache_next_attempt_at<=${sqlLiteral(now)}))
      ORDER BY j.last_served_at IS NOT NULL,j.last_served_at,j.created_at,j.job_id LIMIT 1
    `).get();
    if (!jobs) return null;
    const order = ["semantic_graph", "node_vectors", "hot_cache", "episode_vectors"] as const;
    const start = Math.max(0, order.indexOf(jobs.next_stage as (typeof order)[number]));
    const runnable = (stage: (typeof order)[number]) => stage === "semantic_graph"
      ? Boolean(db.query("SELECT 1 FROM memory_projection_windows w WHERE job_id=? AND state IN ('pending','planned') AND owner_nonce IS NULL AND (state='planned' OR output_json IS NOT NULL OR (SELECT COUNT(DISTINCT a.invocation_ref) FROM memory_projection_attempts a WHERE a.window_ref=w.window_ref AND a.provider_invoked=1 AND a.recovery_revision IS w.recovery_revision)<3) AND (next_attempt_at IS NULL OR next_attempt_at<=?) LIMIT 1").get(jobs.job_id, now))
      : stage === "hot_cache"
        ? Boolean(db.query("SELECT 1 FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.job_id=? AND json_extract(j.hot_cache_state,'$.state')='pending' AND (c.summary_status='complete' OR json_extract(j.semantic_graph_state,'$.state') IN ('complete','failed') OR (json_extract(j.semantic_graph_state,'$.state')='partial' AND COALESCE(json_extract(j.semantic_graph_state,'$.pending_units'),0)=0)) AND (j.hot_cache_next_attempt_at IS NULL OR j.hot_cache_next_attempt_at<=?)").get(jobs.job_id, now))
        : Boolean(db.query("SELECT 1 FROM memory_vector_units WHERE job_id=? AND record_kind=? AND state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) LIMIT 1").get(jobs.job_id, stage === "node_vectors" ? "node" : "episode", now));
    let stage: (typeof order)[number] | null = null;
    for (let offset = 0; offset < order.length; offset += 1) {
      const candidate = order[(start + offset) % order.length]!;
      if (runnable(candidate)) { stage = candidate; break; }
    }
    if (!stage) return null;
    const next = order[(order.indexOf(stage) + 1) % order.length]!;
    db.query("UPDATE memory_projection_jobs SET next_stage=?,last_served_at=? WHERE job_id=?").run(next, now, jobs.job_id);
    return { jobId: jobs.job_id, stage };
  })();
}

function recoverInterruptedHotCache(db: Database, currentPid: number): void {
  for (const row of db.query<{ job_id: string; hot_cache_owner_pid: number | null; hot_cache_state: string }, []>(`
    SELECT job_id,hot_cache_owner_pid,hot_cache_state FROM memory_projection_jobs
    WHERE json_extract(hot_cache_state,'$.state')='running'
  `).all()) {
    if (row.hot_cache_owner_pid !== null && row.hot_cache_owner_pid !== currentPid && !pidAlive(row.hot_cache_owner_pid)) {
      db.query(`UPDATE memory_projection_jobs
        SET hot_cache_state=?,hot_cache_attempt_count=MAX(0,hot_cache_attempt_count-1),hot_cache_receipt_json=?,
            hot_cache_owner_pid=NULL,hot_cache_owner_nonce=NULL,hot_cache_started_at=NULL
        WHERE job_id=? AND json_extract(hot_cache_state,'$.state')='running'`).run(
        JSON.stringify({ state: "pending", blocked_by: null }),
        JSON.stringify({ schema: "butler.memory-hot-cache-receipt.v1", outcome: "interrupted", code: "memory_projection_interrupted" }),
        row.job_id,
      );
    }
  }
}

function recoverInterruptedWindows(
  db: Database,
  currentPid: number,
  isOwnerActive?: (jobId: string, windowRef: string, ownerNonce: string) => boolean,
): void {
  const jobs = new Set<string>();
  for (const row of db.query<{ window_ref: string; job_id: string; owner_pid: number | null; owner_nonce: string | null }, []>("SELECT window_ref,job_id,owner_pid,owner_nonce FROM memory_projection_windows WHERE state IN ('running','planned') AND owner_nonce IS NOT NULL").all()) {
    const abandonedHere = row.owner_pid === currentPid && Boolean(row.owner_nonce) && !isOwnerActive?.(row.job_id, row.window_ref, row.owner_nonce!);
    const deadElsewhere = row.owner_pid !== null && row.owner_pid !== currentPid && !pidAlive(row.owner_pid);
    if (abandonedHere || deadElsewhere) {
      const attempt = db.query<{ attempt_count: number; recovery_revision: string | null; input_sha256: string | null; normalized_plan_json: string | null; output_json: string | null; provider_evidence_json: string | null }, [string]>(
        "SELECT attempt_count,recovery_revision,input_sha256,normalized_plan_json,output_json,provider_evidence_json FROM memory_projection_windows WHERE window_ref=?",
      ).get(row.window_ref)!;
      const invocationUnknown = !attempt.normalized_plan_json && !attempt.output_json && Boolean(db.query(
        `SELECT 1 FROM memory_projection_attempts started WHERE window_ref=? AND invocation_ref=? AND outcome_known=0
          AND NOT EXISTS(SELECT 1 FROM memory_projection_attempts settled WHERE settled.window_ref=started.window_ref
            AND settled.invocation_ref=started.invocation_ref AND settled.outcome_known=1) LIMIT 1`,
      ).get(row.window_ref, row.owner_nonce));
      db.query(`INSERT OR IGNORE INTO memory_projection_attempts
        (attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,output_json,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known,recovery_revision)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`${row.window_ref}:attempt:${attempt.attempt_count}:interrupted`, row.window_ref, row.job_id,
          attempt.attempt_count, "interrupted", "memory_projection_interrupted", attempt.input_sha256, attempt.output_json, attempt.provider_evidence_json, new Date().toISOString(),
          attempt.normalized_plan_json ? "apply" : attempt.output_json ? "validation" : "unknown", 0, 0, attempt.recovery_revision);
      db.query(`UPDATE memory_projection_windows SET state=CASE
          WHEN normalized_plan_json IS NOT NULL THEN 'planned'
          WHEN output_json IS NOT NULL THEN 'pending'
          WHEN ${invocationUnknown ? "1" : "0"}=1 THEN 'failed'
          WHEN (SELECT COUNT(DISTINCT a.invocation_ref) FROM memory_projection_attempts a WHERE a.window_ref=memory_projection_windows.window_ref AND a.provider_invoked=1 AND a.recovery_revision IS memory_projection_windows.recovery_revision)>=3 THEN 'failed'
          ELSE 'pending'
        END,error_code=CASE
          WHEN ${invocationUnknown ? "1" : "0"}=1 THEN 'memory_projection_outcome_unknown'
          WHEN output_json IS NULL AND normalized_plan_json IS NULL AND (SELECT COUNT(DISTINCT a.invocation_ref) FROM memory_projection_attempts a WHERE a.window_ref=memory_projection_windows.window_ref AND a.provider_invoked=1 AND a.recovery_revision IS memory_projection_windows.recovery_revision)>=3 THEN 'memory_projection_attempts_exhausted'
          ELSE 'memory_projection_interrupted' END,
        next_attempt_at=CASE WHEN ${invocationUnknown ? "1" : "0"}=1 OR (output_json IS NULL AND normalized_plan_json IS NULL AND (SELECT COUNT(DISTINCT a.invocation_ref) FROM memory_projection_attempts a WHERE a.window_ref=memory_projection_windows.window_ref AND a.provider_invoked=1 AND a.recovery_revision IS memory_projection_windows.recovery_revision)>=3) THEN NULL ELSE ? END,owner_pid=NULL,owner_nonce=NULL,started_at=NULL
        WHERE window_ref=? AND state IN ('running','planned') AND owner_nonce=?`).run(new Date().toISOString(), row.window_ref, row.owner_nonce);
      jobs.add(row.job_id);
    }
  }
  for (const job of jobs) refreshSemanticState(db, job);
}

export function refreshSemanticState(db: Database, jobId: string): void {
  const counts = db
    .query<{ total: number; complete: number; failed: number }, [string]>(
      `
    SELECT COUNT(*) total,SUM(state='complete') complete,SUM(state IN ('failed','unsupported')) failed
    FROM memory_projection_windows WHERE job_id=? AND state!='replaced'
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
  if (state.state === "complete") {
    const nodeCount = Number(db.query<{ count: number }, [string]>("SELECT COUNT(*) count FROM memory_vector_units WHERE job_id=? AND record_kind='node'").get(jobId)?.count ?? 0);
    if (nodeCount === 0) {
      const current = db.query<{ node_vectors_state: string }, [string]>("SELECT node_vectors_state FROM memory_projection_jobs WHERE job_id=?").get(jobId);
      if (current && (JSON.parse(current.node_vectors_state) as { state: string }).state !== "not_configured") {
        db.query("UPDATE memory_projection_jobs SET node_vectors_state=? WHERE job_id=?").run(JSON.stringify({ state: "complete", completed_units: 0, total_units: 0 }), jobId);
      }
    }
  }
}

export function sourceRows(
  db: Database,
  sourceIds: string[],
): ProjectionSourceRow[] {
  if (sourceIds.length === 0) return [];
  return sourceIds.flatMap((sourceId) => {
    const active = db.query<ProjectionSourceRow, [string]>("SELECT * FROM memory_chunk_sources WHERE source_id=?").get(sourceId);
    if (active) return [active];
    const archived = db.query<ProjectionSourceRow, [string]>(`SELECT source_id,episode_id,revision,source_kind,conversation_session_id,
      conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis
      FROM memory_source_split_parents WHERE source_id=?`).get(sourceId);
    return archived ? [archived] : [];
  });
}

export function expandSplitSourceLeaves(db: Database, sourceId: string): string[] {
  const archived = db.query<{ child_source_ids_json: string }, [string]>("SELECT child_source_ids_json FROM memory_source_split_parents WHERE source_id=?").get(sourceId);
  if (!archived) return [sourceId];
  return (JSON.parse(archived.child_source_ids_json) as string[]).flatMap((child) => expandSplitSourceLeaves(db, child));
}

/** Cache admission outlives the projection job receipt that caused it. */
export function recordHotCacheOutcomes(db: Database, generation: string, receipt: {
  source_id: string; admitted?: boolean;
  excluded_entries?: Array<{ entry_id: string; reason: string }>;
}): void {
  const save = db.query(`INSERT INTO memory_hot_cache_outcomes(entry_id,generation,admitted,reason,receipt_json)
    VALUES(?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET generation=excluded.generation,
    admitted=excluded.admitted,reason=excluded.reason,receipt_json=excluded.receipt_json`);
  db.transaction(() => {
    save.run(receipt.source_id, generation, receipt.admitted === false ? 0 : 1, null, JSON.stringify(receipt));
    for (const excluded of receipt.excluded_entries ?? [])
      save.run(excluded.entry_id, generation, 0, excluded.reason, JSON.stringify(receipt));
  })();
}
