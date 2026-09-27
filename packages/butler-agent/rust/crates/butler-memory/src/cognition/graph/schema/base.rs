use rusqlite::Connection;

use super::super::db_error;
use super::ensure_column;
use crate::cognition::CognitionResult;

pub(super) fn create(connection: &Connection) -> CognitionResult<()> {
    connection.execute_batch(BASE_SCHEMA).map_err(db_error)?;
    ensure_claim_schema(connection)?;
    ensure_source_index_schema(connection)?;
    Ok(())
}

pub(super) fn ensure_historical_columns(connection: &Connection) -> CognitionResult<()> {
    for (table, name, declaration) in HISTORICAL_COLUMNS {
        ensure_column(connection, table, name, declaration)?;
    }
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS memory_nodes_window ON memory_nodes(window_ref);
         CREATE INDEX IF NOT EXISTS idx_windows_due ON memory_projection_windows(state,next_attempt_at,job_id,ordinal);
         CREATE INDEX IF NOT EXISTS idx_vector_units_due ON memory_vector_units(state,next_attempt_at,job_id,record_kind,unit_id);
         CREATE INDEX IF NOT EXISTS idx_memory_chunk_graph_refs_ref ON memory_chunk_graph_refs(graph_ref_type,graph_ref_id);",
    ).map_err(db_error)
}

const BASE_SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS memory_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT OR IGNORE INTO memory_state(key,value) VALUES('graph_revision','0');
INSERT OR IGNORE INTO memory_state(key,value) VALUES('source_graph_schema','3');
CREATE TABLE IF NOT EXISTS memory_chunks(memory_chunk_id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,current_revision TEXT NOT NULL,conversation_session_id TEXT,conversation_turn_id TEXT,conversation_start TEXT,conversation_end TEXT,project_id TEXT,origin_kind TEXT NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',summary_status TEXT NOT NULL DEFAULT 'pending',source_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_chunk_sources(source_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL REFERENCES memory_chunks(memory_chunk_id),revision TEXT NOT NULL,source_kind TEXT NOT NULL,conversation_session_id TEXT,conversation_message_id TEXT,part_id TEXT NOT NULL,scalar_pointer TEXT NOT NULL,byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,content_hash TEXT NOT NULL,role TEXT NOT NULL,origin_kind TEXT NOT NULL,observed_at TEXT NOT NULL,basis TEXT NOT NULL,UNIQUE(episode_id,revision,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end));
CREATE TABLE IF NOT EXISTS memory_nodes(id TEXT PRIMARY KEY,type TEXT NOT NULL,label_original TEXT NOT NULL,identity_scope TEXT NOT NULL,project_id TEXT,canonical_node_id TEXT REFERENCES memory_nodes(id),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_aliases(node_id TEXT NOT NULL REFERENCES memory_nodes(id),surface_original TEXT NOT NULL,nfc_key TEXT NOT NULL,folded_key TEXT NOT NULL,language_tags TEXT NOT NULL DEFAULT '[]',source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),resolution_kind TEXT NOT NULL,PRIMARY KEY(node_id,surface_original,source_id));
CREATE TABLE IF NOT EXISTS memory_evidence(node_id TEXT NOT NULL REFERENCES memory_nodes(id),source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),episode_id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(node_id,source_id));
CREATE TABLE IF NOT EXISTS memory_alias_postings(gram TEXT NOT NULL,node_id TEXT NOT NULL REFERENCES memory_nodes(id),source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),surface_original TEXT NOT NULL,identity_scope TEXT NOT NULL,project_id TEXT,PRIMARY KEY(gram,node_id,source_id,surface_original));
CREATE TABLE IF NOT EXISTS edges(edge_id TEXT PRIMARY KEY,source_node_id TEXT NOT NULL REFERENCES memory_nodes(id),target_node_id TEXT NOT NULL REFERENCES memory_nodes(id),rel_type TEXT NOT NULL,claim_node_id TEXT REFERENCES memory_nodes(id),qualifiers TEXT NOT NULL DEFAULT '{}',valid_from TEXT,valid_to TEXT,status TEXT NOT NULL DEFAULT 'active',UNIQUE(source_node_id,target_node_id,rel_type,claim_node_id,qualifiers));
CREATE TABLE IF NOT EXISTS edge_evidence(edge_id TEXT NOT NULL REFERENCES edges(edge_id),chunk_source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),basis TEXT NOT NULL,extraction_version TEXT NOT NULL,PRIMARY KEY(edge_id,chunk_source_id));
CREATE TABLE IF NOT EXISTS memory_projection_model_policy(id INTEGER PRIMARY KEY CHECK(id=1),primary_model TEXT NOT NULL,primary_effort TEXT NOT NULL,fallback_model TEXT NOT NULL,fallback_effort TEXT NOT NULL,active_slot TEXT NOT NULL CHECK(active_slot IN ('primary','fallback')),updated_at TEXT NOT NULL,last_transition_json TEXT);
CREATE TABLE IF NOT EXISTS memory_projection_jobs(job_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL,revision TEXT NOT NULL,extraction_version TEXT NOT NULL,generation TEXT NOT NULL,extraction_model TEXT NOT NULL,reasoning_effort TEXT NOT NULL,observed_completion_job_ids TEXT NOT NULL,source_state TEXT NOT NULL,semantic_graph_state TEXT NOT NULL,episode_vectors_state TEXT NOT NULL,node_vectors_state TEXT NOT NULL,hot_cache_state TEXT NOT NULL,next_stage TEXT NOT NULL DEFAULT 'semantic_graph',last_served_at TEXT,created_at TEXT NOT NULL,UNIQUE(episode_id,revision,extraction_version));
CREATE TABLE IF NOT EXISTS memory_chunk_graph_refs(memory_chunk_id TEXT NOT NULL REFERENCES memory_chunks(memory_chunk_id),graph_ref_type TEXT NOT NULL,graph_ref_id TEXT NOT NULL,relation TEXT NOT NULL,PRIMARY KEY(memory_chunk_id,graph_ref_type,graph_ref_id,relation));
CREATE TABLE IF NOT EXISTS memory_projection_windows(window_ref TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES memory_projection_jobs(job_id),ordinal INTEGER NOT NULL,source_refs_json TEXT NOT NULL,output_json TEXT,normalized_plan_json TEXT,provider_evidence_json TEXT,state TEXT NOT NULL,error_code TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,owner_pid INTEGER,owner_nonce TEXT,started_at TEXT,input_json TEXT,input_sha256 TEXT,input_migration_note TEXT,parent_window_ref TEXT,replaced_by_json TEXT,UNIQUE(job_id,ordinal));
CREATE TABLE IF NOT EXISTS memory_hot_cache_outcomes(entry_id TEXT PRIMARY KEY,generation TEXT NOT NULL,admitted INTEGER NOT NULL,reason TEXT,receipt_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_projection_attempts(attempt_ref TEXT PRIMARY KEY,window_ref TEXT NOT NULL,job_id TEXT NOT NULL,attempt_count INTEGER NOT NULL,state TEXT NOT NULL,error_code TEXT,input_sha256 TEXT,output_json TEXT,provider_evidence_json TEXT,recorded_at TEXT NOT NULL,attempt_kind TEXT NOT NULL DEFAULT 'provider',provider_invoked INTEGER NOT NULL DEFAULT 0,outcome_known INTEGER NOT NULL DEFAULT 1,invocation_ref TEXT,UNIQUE(window_ref,attempt_count,state));
CREATE TABLE IF NOT EXISTS memory_source_split_parents(source_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL,revision TEXT NOT NULL,source_kind TEXT NOT NULL,conversation_session_id TEXT,conversation_message_id TEXT,part_id TEXT NOT NULL,scalar_pointer TEXT NOT NULL,byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,content_hash TEXT NOT NULL,role TEXT NOT NULL,origin_kind TEXT NOT NULL,observed_at TEXT NOT NULL,basis TEXT NOT NULL,child_source_ids_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
CREATE VIEW IF NOT EXISTS memory_source_leaves AS SELECT s.* FROM memory_chunk_sources s WHERE NOT EXISTS(SELECT 1 FROM memory_source_split_parents p WHERE p.source_id=s.source_id);
CREATE TABLE IF NOT EXISTS memory_vector_units(unit_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES memory_projection_jobs(job_id),record_kind TEXT NOT NULL,owner_id TEXT NOT NULL,owner_revision TEXT NOT NULL,project_id TEXT,origin_kind TEXT NOT NULL,projection_text TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',error_code TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,owner_pid INTEGER,owner_nonce TEXT,started_at TEXT,receipt_json TEXT,source_ids_json TEXT,source_byte_start INTEGER,source_byte_end INTEGER,source_role TEXT,UNIQUE(job_id,record_kind,owner_id,owner_revision,project_id,origin_kind));
CREATE INDEX IF NOT EXISTS idx_alias_nfc ON memory_aliases(nfc_key,node_id); CREATE INDEX IF NOT EXISTS idx_alias_folded ON memory_aliases(folded_key,node_id); CREATE INDEX IF NOT EXISTS memory_evidence_episode ON memory_evidence(episode_id,node_id,source_id); CREATE INDEX IF NOT EXISTS memory_evidence_source ON memory_evidence(source_id,node_id); CREATE INDEX IF NOT EXISTS memory_edges_claim ON edges(claim_node_id,status,rel_type); CREATE INDEX IF NOT EXISTS idx_edges_source_rel ON edges(source_node_id,rel_type); CREATE INDEX IF NOT EXISTS idx_edges_target_rel ON edges(target_node_id,rel_type); CREATE INDEX IF NOT EXISTS idx_mentions_entity_episode ON memory_evidence(node_id,episode_id); CREATE INDEX IF NOT EXISTS idx_sources_message_revision ON memory_chunk_sources(conversation_message_id,revision); CREATE INDEX IF NOT EXISTS idx_chunks_project_origin ON memory_chunks(project_id,origin_kind,conversation_start,memory_chunk_id); CREATE INDEX IF NOT EXISTS idx_jobs_state ON memory_projection_jobs(last_served_at,created_at,job_id); CREATE INDEX IF NOT EXISTS idx_vector_units_state ON memory_vector_units(state,job_id,record_kind,unit_id);
";

fn ensure_claim_schema(connection: &Connection) -> CognitionResult<()> {
    connection.execute_batch(r"CREATE TABLE IF NOT EXISTS memory_claims(node_id TEXT PRIMARY KEY REFERENCES memory_nodes(id),statement TEXT NOT NULL,speech_act TEXT NOT NULL,basis TEXT NOT NULL,polarity TEXT NOT NULL,condition TEXT,requirement TEXT,valid_from TEXT,valid_to TEXT,salience TEXT NOT NULL,source_class TEXT NOT NULL CHECK(source_class IN ('user','assistant','task_report','explicit','mixed','unknown')),authority TEXT NOT NULL DEFAULT 'model_interpretation' CHECK(authority='model_interpretation'));
CREATE TABLE IF NOT EXISTS memory_mentions(node_id TEXT NOT NULL REFERENCES memory_nodes(id),source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),byte_start INTEGER,byte_end INTEGER,surface TEXT NOT NULL,method TEXT NOT NULL CHECK(method IN ('literal','inferred')),CHECK((method='literal' AND byte_start>=0 AND byte_end>byte_start) OR (method='inferred' AND byte_start IS NULL AND byte_end IS NULL)),PRIMARY KEY(node_id,source_id,surface));
CREATE TABLE IF NOT EXISTS memory_meaning_commits(window_ref TEXT PRIMARY KEY REFERENCES memory_projection_windows(window_ref),input_hash TEXT NOT NULL,output_json TEXT NOT NULL,plan_json TEXT NOT NULL,committed_at TEXT NOT NULL);").map_err(db_error)
}

fn ensure_source_index_schema(connection: &Connection) -> CognitionResult<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS memory_source_text(id INTEGER PRIMARY KEY,source_id TEXT NOT NULL UNIQUE REFERENCES memory_chunk_sources(source_id),text TEXT NOT NULL,text_hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS memory_source_terms(term TEXT NOT NULL,source_key INTEGER NOT NULL REFERENCES memory_source_text(id),PRIMARY KEY(term,source_key)) WITHOUT ROWID; CREATE INDEX IF NOT EXISTS idx_source_terms_source ON memory_source_terms(source_key);").map_err(db_error)
}

const HISTORICAL_COLUMNS: &[(&str, &str, &str)] = &[
    (
        "memory_nodes",
        "window_ref",
        "TEXT REFERENCES memory_projection_windows(window_ref)",
    ),
    ("memory_projection_jobs", "hot_cache_receipt_json", "TEXT"),
    (
        "memory_projection_jobs",
        "identity_decisions_json",
        "TEXT NOT NULL DEFAULT '[]'",
    ),
    (
        "memory_nodes",
        "identity_history_job_id",
        "TEXT REFERENCES memory_projection_jobs(job_id)",
    ),
    ("memory_nodes", "identity_history_ref", "TEXT"),
    (
        "memory_projection_jobs",
        "hot_cache_attempt_count",
        "INTEGER NOT NULL DEFAULT 0",
    ),
    (
        "memory_projection_jobs",
        "hot_cache_next_attempt_at",
        "TEXT",
    ),
    ("memory_projection_jobs", "hot_cache_owner_pid", "INTEGER"),
    ("memory_projection_jobs", "hot_cache_owner_nonce", "TEXT"),
    ("memory_projection_jobs", "hot_cache_started_at", "TEXT"),
    (
        "memory_projection_windows",
        "attempt_count",
        "INTEGER NOT NULL DEFAULT 0",
    ),
    ("memory_projection_windows", "next_attempt_at", "TEXT"),
    ("memory_projection_windows", "owner_pid", "INTEGER"),
    ("memory_projection_windows", "owner_nonce", "TEXT"),
    ("memory_projection_windows", "started_at", "TEXT"),
    ("memory_projection_windows", "input_json", "TEXT"),
    (
        "memory_projection_windows",
        "extraction_stages_json",
        "TEXT NOT NULL DEFAULT '{}'",
    ),
    ("memory_projection_windows", "input_sha256", "TEXT"),
    ("memory_projection_windows", "input_migration_note", "TEXT"),
    ("memory_projection_windows", "parent_window_ref", "TEXT"),
    ("memory_projection_windows", "replaced_by_json", "TEXT"),
    ("memory_projection_windows", "recovery_revision", "TEXT"),
    (
        "memory_projection_windows",
        "recovery_base_attempt_count",
        "INTEGER NOT NULL DEFAULT 0",
    ),
    ("memory_projection_attempts", "recovery_revision", "TEXT"),
    (
        "memory_projection_attempts",
        "recovery_request_json",
        "TEXT",
    ),
    (
        "memory_projection_attempts",
        "attempt_kind",
        "TEXT NOT NULL DEFAULT 'provider'",
    ),
    (
        "memory_projection_attempts",
        "provider_invoked",
        "INTEGER NOT NULL DEFAULT 0",
    ),
    (
        "memory_projection_attempts",
        "outcome_known",
        "INTEGER NOT NULL DEFAULT 1",
    ),
    ("memory_projection_attempts", "invocation_ref", "TEXT"),
    (
        "memory_vector_units",
        "attempt_count",
        "INTEGER NOT NULL DEFAULT 0",
    ),
    ("memory_vector_units", "next_attempt_at", "TEXT"),
    ("memory_vector_units", "owner_pid", "INTEGER"),
    ("memory_vector_units", "owner_nonce", "TEXT"),
    ("memory_vector_units", "started_at", "TEXT"),
    ("memory_vector_units", "receipt_json", "TEXT"),
    (
        "memory_vector_units",
        "provider_invoked",
        "INTEGER NOT NULL DEFAULT 0",
    ),
    (
        "memory_vector_units",
        "outcome_known",
        "INTEGER NOT NULL DEFAULT 1",
    ),
    ("memory_vector_units", "invocation_ref", "TEXT"),
    ("memory_vector_units", "source_ids_json", "TEXT"),
    ("memory_vector_units", "source_byte_start", "INTEGER"),
    ("memory_vector_units", "source_byte_end", "INTEGER"),
    ("memory_vector_units", "source_role", "TEXT"),
];
