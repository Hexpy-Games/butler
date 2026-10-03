//! Lossless survivor closure for the shared graph. Canonical sources are untouched.
use butler_platform::sqlite;
use rusqlite::Connection;
use std::{io, path::Path};
use tokio_util::sync::CancellationToken;

pub(super) fn prune(
    root: &Path,
    graph: &Path,
    project: Option<&str>,
    generation: &str,
    token: &CancellationToken,
) -> io::Result<()> {
    let mut db = sqlite::open(graph).map_err(io::Error::other)?;
    let cancellation = token.clone();
    db.progress_handler(1000, Some(move || cancellation.is_cancelled()));
    let tx = db.transaction().map_err(io::Error::other)?;
    crate::coordination::capture_project_admission_floor(root, &tx, token, project)?;
    tx.execute_batch("CREATE TEMP TABLE reset_chunks(id TEXT PRIMARY KEY); CREATE TEMP TABLE reset_sources(id TEXT PRIMARY KEY); CREATE TEMP TABLE reset_jobs(id TEXT PRIMARY KEY);").map_err(io::Error::other)?;
    tx.execute("INSERT INTO reset_chunks SELECT memory_chunk_id FROM memory_chunks c WHERE (?1 IS NULL OR project_id=?1) AND EXISTS(SELECT 1 FROM memory_chunk_sources s WHERE s.episode_id=c.memory_chunk_id AND (s.source_kind='conversation' OR (?1 IS NOT NULL AND c.status='forgotten' AND s.source_kind='explicit_record')))", [project]).map_err(io::Error::other)?;
    if let Some(project) = project {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS memory_project_resets(project_id TEXT PRIMARY KEY,epoch TEXT NOT NULL)").map_err(io::Error::other)?;
        tx.execute("INSERT INTO memory_project_resets(project_id,epoch) VALUES(?1,?2) ON CONFLICT(project_id) DO UPDATE SET epoch=excluded.epoch", (project, generation)).map_err(io::Error::other)?;
    }
    tx.execute_batch(PRUNE).map_err(io::Error::other)?;
    tx.execute(
        "UPDATE memory_projection_jobs SET generation=?1",
        [generation],
    )
    .map_err(io::Error::other)?;
    tx.execute(
        "UPDATE memory_hot_cache_outcomes SET generation=?1",
        [generation],
    )
    .map_err(io::Error::other)?;
    tx.execute_batch(
        "UPDATE memory_state SET value=CAST(value AS INTEGER)+1 WHERE key='graph_revision';",
    )
    .map_err(io::Error::other)?;
    validate(&tx)?;
    tx.commit().map_err(io::Error::other)?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(io::Error::other)?;
    butler_platform::secure_fs::sync_path(graph)
}

fn validate(db: &Connection) -> io::Result<()> {
    let mut foreign_keys = db
        .prepare("PRAGMA foreign_key_check")
        .map_err(io::Error::other)?;
    if foreign_keys
        .query([])
        .map_err(io::Error::other)?
        .next()
        .map_err(io::Error::other)?
        .is_some()
    {
        return Err(io::Error::other("Surviving graph has broken references"));
    }
    Ok(())
}

const PRUNE: &str = "
INSERT INTO reset_sources SELECT source_id FROM memory_chunk_sources WHERE episode_id IN reset_chunks;
INSERT INTO reset_jobs SELECT job_id FROM memory_projection_jobs WHERE episode_id IN reset_chunks;
DELETE FROM memory_source_terms WHERE source_key IN (SELECT id FROM memory_source_text WHERE source_id IN reset_sources);
DELETE FROM memory_source_text WHERE source_id IN reset_sources;
DELETE FROM memory_alias_postings WHERE source_id IN reset_sources;
DELETE FROM memory_aliases WHERE source_id IN reset_sources;
DELETE FROM memory_mentions WHERE source_id IN reset_sources;
DELETE FROM memory_evidence WHERE source_id IN reset_sources;
DELETE FROM edge_evidence WHERE chunk_source_id IN reset_sources;
DELETE FROM memory_chunk_graph_refs WHERE memory_chunk_id IN reset_chunks;
DELETE FROM edges WHERE NOT EXISTS(SELECT 1 FROM edge_evidence e WHERE e.edge_id=edges.edge_id) AND NOT EXISTS(SELECT 1 FROM memory_chunk_graph_refs r WHERE r.graph_ref_type='edge' AND r.graph_ref_id=edges.edge_id);
CREATE TEMP TABLE reset_keep_nodes(id TEXT PRIMARY KEY);
INSERT OR IGNORE INTO reset_keep_nodes SELECT node_id FROM memory_evidence;
INSERT OR IGNORE INTO reset_keep_nodes SELECT node_id FROM memory_aliases;
INSERT OR IGNORE INTO reset_keep_nodes SELECT node_id FROM memory_alias_postings;
INSERT OR IGNORE INTO reset_keep_nodes SELECT node_id FROM memory_mentions;
INSERT OR IGNORE INTO reset_keep_nodes SELECT source_node_id FROM edges;
INSERT OR IGNORE INTO reset_keep_nodes SELECT target_node_id FROM edges;
INSERT OR IGNORE INTO reset_keep_nodes SELECT claim_node_id FROM edges WHERE claim_node_id IS NOT NULL;
INSERT OR IGNORE INTO reset_keep_nodes SELECT graph_ref_id FROM memory_chunk_graph_refs WHERE graph_ref_type='node';
INSERT OR IGNORE INTO reset_keep_nodes WITH RECURSIVE parents(id) AS (SELECT id FROM reset_keep_nodes UNION SELECT n.canonical_node_id FROM memory_nodes n JOIN parents p ON p.id=n.id WHERE n.canonical_node_id IS NOT NULL) SELECT id FROM parents;
DELETE FROM memory_alias_postings WHERE node_id NOT IN reset_keep_nodes;
DELETE FROM memory_aliases WHERE node_id NOT IN reset_keep_nodes;
DELETE FROM memory_mentions WHERE node_id NOT IN reset_keep_nodes;
DELETE FROM memory_claims WHERE node_id NOT IN reset_keep_nodes;
UPDATE memory_nodes SET canonical_node_id=NULL WHERE id NOT IN reset_keep_nodes;
DELETE FROM memory_nodes WHERE id NOT IN reset_keep_nodes;
UPDATE memory_nodes SET window_ref=NULL WHERE window_ref IN (SELECT window_ref FROM memory_projection_windows WHERE job_id IN reset_jobs);
UPDATE memory_nodes SET identity_history_job_id=NULL,identity_history_ref=NULL WHERE identity_history_job_id IN reset_jobs;
DELETE FROM memory_meaning_commits WHERE window_ref IN (SELECT window_ref FROM memory_projection_windows WHERE job_id IN reset_jobs);
DELETE FROM memory_projection_attempts WHERE job_id IN reset_jobs;
DELETE FROM memory_projection_windows WHERE job_id IN reset_jobs;
DELETE FROM memory_vector_units WHERE job_id IN reset_jobs OR (record_kind='node' AND owner_id NOT IN reset_keep_nodes);
DELETE FROM memory_projection_jobs WHERE job_id IN reset_jobs;
DELETE FROM memory_source_split_parents WHERE episode_id IN reset_chunks;
DELETE FROM memory_chunk_sources WHERE episode_id IN reset_chunks;
DELETE FROM memory_hot_cache_outcomes WHERE json_extract(receipt_json,'$.episode_id') IN reset_chunks;
DELETE FROM memory_chunks WHERE memory_chunk_id IN reset_chunks;
";
