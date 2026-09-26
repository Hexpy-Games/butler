//! Stage counts and persisted receipts from current candidate jobs.

use rusqlite::{Connection, params};
use serde::Serialize;

use super::{GraphRepository, db_error};
use crate::cognition::CognitionResult;

#[derive(Clone, Default, Serialize)]
pub(in crate::cognition) struct StageCounts {
    pub complete: usize,
    pub pending: usize,
    pub failed: usize,
    pub not_configured: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported: Option<usize>,
}

#[derive(Clone, Serialize)]
pub(in crate::cognition) struct VectorReadinessRow {
    pub unit_id: String,
    pub record_kind: String,
    pub owner_id: String,
    pub owner_revision: String,
    pub projection_text: String,
    pub project_id: Option<String>,
    pub origin_kind: String,
    pub receipt_json: Option<String>,
    pub source_revision: String,
    pub conversation_session_id: Option<String>,
    pub source_kind: Option<String>,
    pub source_observed_at: Option<String>,
    pub source_ids_json: Option<String>,
    pub source_membership_invalid: bool,
}

#[derive(Clone, Serialize)]
pub(in crate::cognition) struct CacheReadinessRow {
    pub job_id: String,
    pub revision: String,
    pub receipt_json: Option<String>,
}

pub(in crate::cognition) struct StageReadiness {
    pub semantic: StageCounts,
    pub vectors: StageCounts,
    pub cache: StageCounts,
    pub vector_rows: Vec<VectorReadinessRow>,
    pub cache_rows: Vec<CacheReadinessRow>,
}

impl GraphRepository {
    pub(in crate::cognition) fn complete_rebuild_cache_rows(
        &self,
        generation: &str,
    ) -> CognitionResult<Vec<CacheReadinessRow>> {
        cache_rows(self.connection()?, generation)
    }

    pub(in crate::cognition) fn rebuild_stage_readiness(
        &self,
        generation: &str,
    ) -> CognitionResult<StageReadiness> {
        let db = self.connection()?;
        let semantic = stage_counts(db, generation, "memory_projection_windows", "w.state", true)?;
        let vectors = stage_counts(db, generation, "memory_vector_units", "w.state", false)?;
        let cache = cache_counts(db, generation)?;
        Ok(StageReadiness {
            semantic,
            vectors,
            cache,
            vector_rows: vector_rows(db, generation)?,
            cache_rows: cache_rows(db, generation)?,
        })
    }
}

fn stage_counts(
    db: &Connection,
    generation: &str,
    table: &str,
    state: &str,
    semantic: bool,
) -> CognitionResult<StageCounts> {
    let sql = format!(
        "SELECT {state},COUNT(*) FROM {table} w JOIN memory_projection_jobs j ON w.job_id=j.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation=?1 GROUP BY {state}"
    );
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    let rows = statement
        .query_map([generation], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, usize>(1)?))
        })
        .map_err(db_error)?;
    let mut counts = StageCounts {
        unsupported: semantic.then_some(0),
        ..Default::default()
    };
    for row in rows {
        let (state, count) = row.map_err(db_error)?;
        match state.as_str() {
            "complete" => counts.complete += count,
            "unsupported" if semantic => {
                *counts.unsupported.as_mut().expect("semantic count") += count
            }
            "pending" | "planned" | "running" => counts.pending += count,
            "failed" => counts.failed += count,
            "not_configured" if !semantic => counts.not_configured += count,
            _ => {}
        }
    }
    Ok(counts)
}

fn cache_counts(db: &Connection, generation: &str) -> CognitionResult<StageCounts> {
    let mut statement=db.prepare("SELECT json_extract(j.hot_cache_state,'$.state'),COUNT(*) FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation=?1 GROUP BY 1").map_err(db_error)?;
    let rows = statement
        .query_map([generation], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, usize>(1)?))
        })
        .map_err(db_error)?;
    let mut counts = StageCounts::default();
    for row in rows {
        let (state, count) = row.map_err(db_error)?;
        match state.as_str() {
            "complete" => counts.complete += count,
            "pending" | "running" | "partial" => counts.pending += count,
            "failed" => counts.failed += count,
            "not_configured" => counts.not_configured += count,
            _ => {}
        }
    }
    Ok(counts)
}

fn vector_rows(db: &Connection, generation: &str) -> CognitionResult<Vec<VectorReadinessRow>> {
    let mut statement = db.prepare(
        "SELECT u.unit_id,u.record_kind,u.owner_id,u.owner_revision,u.projection_text,u.project_id,u.origin_kind,u.receipt_json,j.revision,c.conversation_session_id,
         (SELECT s.source_kind FROM memory_chunk_sources s WHERE s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision ORDER BY s.source_id LIMIT 1),
         (SELECT s.observed_at FROM memory_chunk_sources s WHERE s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision AND (u.source_ids_json IS NULL OR s.source_id IN (SELECT value FROM json_each(u.source_ids_json))) AND (u.record_kind='episode' OR (s.origin_kind=u.origin_kind AND EXISTS(SELECT 1 FROM memory_evidence own WHERE own.source_id=s.source_id AND own.node_id=u.owner_id))) ORDER BY julianday(s.observed_at) DESC,s.source_id DESC LIMIT 1),
         u.source_ids_json,
         CASE WHEN NOT (u.project_id IS c.project_id) OR u.source_ids_json IS NULL OR json_array_length(u.source_ids_json)=0 OR EXISTS(SELECT 1 FROM json_each(u.source_ids_json) refs WHERE NOT EXISTS(SELECT 1 FROM memory_chunk_sources s WHERE s.source_id=refs.value AND s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision AND (u.record_kind!='node' OR (s.origin_kind=u.origin_kind AND EXISTS(SELECT 1 FROM memory_evidence e WHERE e.node_id=u.owner_id AND e.source_id=s.source_id AND e.episode_id=c.memory_chunk_id AND e.revision=c.current_revision))))) THEN 1 ELSE 0 END
         FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation=?1 AND u.state='complete' ORDER BY u.unit_id"
    ).map_err(db_error)?;
    statement
        .query_map(params![generation], |row| {
            Ok(VectorReadinessRow {
                unit_id: row.get(0)?,
                record_kind: row.get(1)?,
                owner_id: row.get(2)?,
                owner_revision: row.get(3)?,
                projection_text: row.get(4)?,
                project_id: row.get(5)?,
                origin_kind: row.get(6)?,
                receipt_json: row.get(7)?,
                source_revision: row.get(8)?,
                conversation_session_id: row.get(9)?,
                source_kind: row.get(10)?,
                source_observed_at: row.get(11)?,
                source_ids_json: row.get(12)?,
                source_membership_invalid: row.get::<_, i64>(13)? != 0,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}

fn cache_rows(db: &Connection, generation: &str) -> CognitionResult<Vec<CacheReadinessRow>> {
    let mut statement=db.prepare("SELECT j.job_id,j.revision,j.hot_cache_receipt_json FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation=?1 AND json_extract(j.hot_cache_state,'$.state')='complete' ORDER BY j.job_id").map_err(db_error)?;
    statement
        .query_map([generation], |row| {
            Ok(CacheReadinessRow {
                job_id: row.get(0)?,
                revision: row.get(1)?,
                receipt_json: row.get(2)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}
