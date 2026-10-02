//! Durable claim and receipt transitions for current vector units.

use crate::cognition::CognitionCode;
use crate::cognition::graph::StageWrite;
use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::db_error;
use crate::cognition::{CognitionError, CognitionResult};
mod recovery;
use recovery::recover;

#[derive(Clone, Debug)]
pub(in crate::cognition) struct ClaimedVectorUnit {
    pub unit_id: String,
    pub job_id: String,
    pub record_kind: String,
    pub owner_id: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub projection_text: String,
    pub project_id: Option<String>,
    pub origin_kind: String,
    pub source_kind: String,
    pub conversation_session_id: Option<String>,
    pub source_observed_at: String,
    pub source_refs_json: String,
    pub source_key: String,
    pub source_hash: String,
    pub extraction_version: String,
    pub session_id: Option<String>,
    pub owner_nonce: String,
    pub attempt_count: i64,
}

/// A pending unit as selected, before its source facts are required.
struct PendingUnit {
    unit_id: String,
    job_id: String,
    record_kind: String,
    owner_id: String,
    owner_revision: String,
    source_revision: String,
    projection_text: String,
    project_id: Option<String>,
    origin_kind: String,
    source_kind: Option<String>,
    conversation_session_id: Option<String>,
    source_observed_at: Option<String>,
    source_refs_json: Option<String>,
    attempt_count: i64,
    source_key: String,
    source_hash: String,
    extraction_version: String,
    session_id: Option<String>,
}

const PENDING_UNITS_SQL: &str = "SELECT u.unit_id,u.job_id,u.record_kind,u.owner_id,u.owner_revision,j.revision,u.projection_text, \
         u.project_id,u.origin_kind, \
         (SELECT s.source_kind FROM memory_chunk_sources s WHERE s.episode_id=j.episode_id AND s.revision=j.revision \
           ORDER BY s.source_id LIMIT 1), \
         c.conversation_session_id, \
         (SELECT s.observed_at FROM memory_chunk_sources s WHERE s.episode_id=j.episode_id AND s.revision=j.revision \
           AND (u.source_ids_json IS NULL OR s.source_id IN (SELECT value FROM json_each(u.source_ids_json))) \
           AND (u.record_kind='episode' OR (s.origin_kind=u.origin_kind AND EXISTS(SELECT 1 FROM memory_evidence own WHERE own.source_id=s.source_id AND own.node_id=u.owner_id))) \
           ORDER BY julianday(s.observed_at) DESC,s.source_id DESC LIMIT 1), \
         u.source_ids_json,u.attempt_count,c.source_key,c.source_hash,j.extraction_version,c.conversation_session_id \
         FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id \
         JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision \
         WHERE u.job_id=?1 AND u.record_kind=?2 AND u.state='pending' \
           AND json_extract(j.semantic_graph_state,'$.state')='complete' \
           AND (u.next_attempt_at IS NULL OR u.next_attempt_at<=?3) \
         ORDER BY u.unit_id LIMIT 4";

fn pending_unit(row: &rusqlite::Row<'_>) -> rusqlite::Result<PendingUnit> {
    Ok(PendingUnit {
        unit_id: row.get(0)?,
        job_id: row.get(1)?,
        record_kind: row.get(2)?,
        owner_id: row.get(3)?,
        owner_revision: row.get(4)?,
        source_revision: row.get(5)?,
        projection_text: row.get(6)?,
        project_id: row.get(7)?,
        origin_kind: row.get(8)?,
        source_kind: row.get(9)?,
        conversation_session_id: row.get(10)?,
        source_observed_at: row.get(11)?,
        source_refs_json: row.get(12)?,
        attempt_count: row.get(13)?,
        source_key: row.get(14)?,
        source_hash: row.get(15)?,
        extraction_version: row.get(16)?,
        session_id: row.get(17)?,
    })
}

/// Claims up to four pending units of the next job and kind whose semantic
/// stage is complete, marking the units and the job's vector stage running.
pub(super) fn claim(
    connection: &mut Connection,
    now: &str,
) -> CognitionResult<Vec<ClaimedVectorUnit>> {
    let tx = connection.transaction().map_err(db_error)?;
    recover(&tx)?;
    let Some((job, kind)) = next_pending_group(&tx, now)? else {
        tx.commit().map_err(db_error)?;
        return Ok(Vec::new());
    };
    let nonce = uuid::Uuid::new_v4().to_string();
    let mut statement = tx.prepare(PENDING_UNITS_SQL).map_err(db_error)?;
    let selected = statement
        .query_map(params![job, kind, now], pending_unit)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(statement);
    let mut units = Vec::with_capacity(selected.len());
    for pending in selected {
        units.push(claim_unit(&tx, pending, &nonce, now)?);
    }
    if let Some(first) = units.first() {
        let column = if first.record_kind == "node" {
            "node_vectors_state"
        } else {
            "episode_vectors_state"
        };
        let running = StageWrite::Running {
            attempt: first.attempt_count,
            owner_pid: std::process::id(),
            started_at: now.to_owned(),
        };
        tx.execute(
            &format!("UPDATE memory_projection_jobs SET {column}=?1 WHERE job_id=?2"),
            params![running.json()?, first.job_id],
        )
        .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)?;
    Ok(units)
}

/// The job and record kind of the next due pending unit.
fn next_pending_group(tx: &Connection, now: &str) -> CognitionResult<Option<(String, String)>> {
    tx.query_row(
        "SELECT u.job_id,u.record_kind FROM memory_vector_units u \
         JOIN memory_projection_jobs j ON j.job_id=u.job_id \
         JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision \
         WHERE u.state='pending' AND json_extract(j.semantic_graph_state,'$.state')='complete' \
           AND (u.next_attempt_at IS NULL OR u.next_attempt_at<=?1) \
         ORDER BY j.last_served_at IS NOT NULL,j.last_served_at,j.created_at,j.job_id,u.unit_id LIMIT 1",
        [now],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(db_error)
}

/// Marks one unit running under `nonce`; its source facts must be present.
fn claim_unit(
    tx: &Connection,
    pending: PendingUnit,
    nonce: &str,
    now: &str,
) -> CognitionResult<ClaimedVectorUnit> {
    let (Some(source_kind), Some(source_observed_at), Some(source_refs_json)) = (
        pending.source_kind,
        pending.source_observed_at,
        pending.source_refs_json,
    ) else {
        return Err(error(CognitionCode::MemorySourceChanged));
    };
    let changed = tx.execute(
        "UPDATE memory_vector_units SET state='running',error_code=NULL,attempt_count=attempt_count+1,owner_pid=?1,owner_nonce=?2,started_at=?3,next_attempt_at=NULL,provider_invoked=0,outcome_known=1,invocation_ref=NULL WHERE unit_id=?4 AND state='pending'",
        params![i64::from(std::process::id()),nonce,now,pending.unit_id],
    ).map_err(db_error)?;
    if changed != 1 {
        return Err(error(CognitionCode::MemoryVectorUnitChanged));
    }
    Ok(ClaimedVectorUnit {
        unit_id: pending.unit_id,
        job_id: pending.job_id,
        record_kind: pending.record_kind,
        owner_id: pending.owner_id,
        owner_revision: pending.owner_revision,
        source_revision: pending.source_revision,
        projection_text: pending.projection_text,
        project_id: pending.project_id,
        origin_kind: pending.origin_kind,
        source_kind,
        conversation_session_id: pending.conversation_session_id,
        source_observed_at,
        source_refs_json,
        source_key: pending.source_key,
        source_hash: pending.source_hash,
        extraction_version: pending.extraction_version,
        session_id: pending.session_id,
        owner_nonce: nonce.to_owned(),
        attempt_count: pending.attempt_count + 1,
    })
}

pub(super) fn assert_current(
    connection: &Connection,
    generation: &str,
    units: &[ClaimedVectorUnit],
) -> CognitionResult<()> {
    for unit in units {
        let current: Option<i64> = connection.query_row(
            "SELECT 1 FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id \
             JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision \
             WHERE u.unit_id=?1 AND u.state='running' AND u.owner_nonce=?2 AND j.generation=?3 AND j.revision=?4",
            params![unit.unit_id,unit.owner_nonce,generation,unit.source_revision], |_| Ok(1)
        ).optional().map_err(db_error)?;
        if current.is_none() {
            return Err(error(CognitionCode::MemorySourceChanged));
        }
    }
    Ok(())
}

pub(super) fn current_candidate(
    connection: &Connection,
    generation: &str,
    hit: &crate::cognition::recall::RecallVectorMatch,
) -> CognitionResult<bool> {
    let row: Option<(String, String, String, String, String, String, String)> = connection
        .query_row(
            "SELECT u.projection_text,u.source_ids_json,COALESCE(u.project_id,''),u.origin_kind, \
         j.revision,c.current_revision,u.receipt_json \
         FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id \
         JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id \
         WHERE u.record_kind='node' AND u.owner_id=?1 AND u.owner_revision=?2 \
           AND u.state='complete' AND j.generation=?3 AND j.revision=?4 \
           AND EXISTS(SELECT 1 FROM json_each(json_extract(u.receipt_json,'$.vector_keys')) \
             WHERE value=?5) LIMIT 1",
            params![
                hit.owner_id,
                hit.owner_revision,
                generation,
                hit.source_revision,
                hit.vector_key
            ],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .optional()
        .map_err(db_error)?;
    let Some((text, refs, project, origin, revision, current, receipt)) = row else {
        return Ok(false);
    };
    if revision != current
        || refs != hit.source_refs_json
        || project != hit.project_id
        || origin != hit.origin_kind
        || hit.generation != generation
    {
        return Ok(false);
    }
    let chunk = format!(
        "{:x}",
        Sha256::digest(
            json!(["embedding-chunk", hit.owner_revision, 0, text])
                .to_string()
                .as_bytes()
        )
    );
    let key = format!(
        "{:x}",
        Sha256::digest(
            json!([
                "memory-vector",
                generation,
                "node",
                hit.owner_id,
                hit.owner_revision,
                chunk,
                hit.embedding_version
            ])
            .to_string()
            .as_bytes()
        )
    );
    let parsed: serde_json::Value = serde_json::from_str(&receipt)
        .map_err(|source| error(CognitionCode::MemoryVectorReceiptMismatch).with_source(source))?;
    Ok(chunk == hit.embedding_chunk_id
        && key == hit.vector_key
        && parsed.get("generation").and_then(|v| v.as_str()) == Some(generation)
        && parsed.get("embedding_version").and_then(|v| v.as_str())
            == Some(hit.embedding_version.as_str()))
}

pub(super) fn invoked(
    connection: &mut Connection,
    units: &[ClaimedVectorUnit],
) -> CognitionResult<()> {
    let tx = connection.transaction().map_err(db_error)?;
    for unit in units {
        if tx.execute("UPDATE memory_vector_units SET provider_invoked=1,outcome_known=0,invocation_ref=?1 WHERE unit_id=?2 AND state='running' AND owner_nonce=?3", params![unit.owner_nonce,unit.unit_id,unit.owner_nonce]).map_err(db_error)? !=1 {
            return Err(error(CognitionCode::MemoryVectorUnitChanged));
        }
    }
    tx.commit().map_err(db_error)
}

pub(super) fn received(
    connection: &mut Connection,
    units: &[ClaimedVectorUnit],
) -> CognitionResult<()> {
    let tx = connection.transaction().map_err(db_error)?;
    for unit in units {
        if tx.execute("UPDATE memory_vector_units SET outcome_known=1 WHERE unit_id=?1 AND state='running' AND owner_nonce=?2 AND provider_invoked=1", params![unit.unit_id,unit.owner_nonce]).map_err(db_error)? !=1 {
            return Err(error(CognitionCode::MemoryVectorUnitChanged));
        }
    }
    tx.commit().map_err(db_error)
}

pub(super) fn complete(
    connection: &mut Connection,
    units: &[ClaimedVectorUnit],
    receipt: &str,
    now: &str,
) -> CognitionResult<()> {
    if units.is_empty() {
        return Err(error(CognitionCode::MemoryVectorBatchLimit));
    }
    let tx = connection.transaction().map_err(db_error)?;
    for unit in units {
        if tx.execute("UPDATE memory_vector_units SET state='complete',error_code=NULL,owner_pid=NULL,owner_nonce=NULL,started_at=NULL,receipt_json=?1,outcome_known=1 WHERE unit_id=?2 AND owner_nonce=?3 AND state='running'", params![receipt,unit.unit_id,unit.owner_nonce]).map_err(db_error)? !=1 {
            return Err(error(CognitionCode::MemoryVectorUnitChanged));
        }
    }
    if let Some(first) = units.first() {
        refresh(&tx, &first.job_id, now)?;
    }
    tx.commit().map_err(db_error)
}

pub(super) fn fail(
    connection: &mut Connection,
    units: &[ClaimedVectorUnit],
    code: &str,
    now: &str,
) -> CognitionResult<()> {
    if units.is_empty() {
        return Err(error(CognitionCode::MemoryVectorBatchLimit));
    }
    let tx = connection.transaction().map_err(db_error)?;
    for unit in units {
        // A warm-only request lost its worker before invocation. Keep it pending
        // without an error, retry delay or consumed provider attempt.
        let deferred = code == "embed_worker_cold";
        let retryable = deferred
            || unit.attempt_count < 3
                && matches!(
                    code,
                    "memory_embedding_unavailable"
                        | "embed_asset_download_failed"
                        | "embed_request_deadline"
                        | "embed_queue_full"
                        | "memory_write_busy"
                        | "memory_vector_io_transient"
                );
        let next_attempt = (retryable && !deferred).then(|| {
            let delay = if unit.attempt_count == 1 { 30 } else { 120 };
            (chrono::Utc::now() + chrono::Duration::seconds(delay))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
        tx.execute("UPDATE memory_vector_units SET state=?1,error_code=?2,next_attempt_at=?3,owner_pid=NULL,owner_nonce=NULL,started_at=NULL,outcome_known=1,attempt_count=CASE WHEN ?6 THEN MAX(0,attempt_count-1) ELSE attempt_count END,provider_invoked=CASE WHEN ?6 THEN 0 ELSE provider_invoked END,invocation_ref=CASE WHEN ?6 THEN NULL ELSE invocation_ref END WHERE unit_id=?4 AND owner_nonce=?5", params![if retryable {"pending"} else {"failed"},if deferred { None } else { Some(code) },next_attempt,unit.unit_id,unit.owner_nonce,deferred]).map_err(db_error)?;
    }
    if let Some(first) = units.first() {
        refresh(&tx, &first.job_id, now)?;
    }
    tx.commit().map_err(db_error)
}

fn refresh(connection: &Connection, job: &str, now: &str) -> CognitionResult<()> {
    for (kind, column) in [
        ("node", "node_vectors_state"),
        ("episode", "episode_vectors_state"),
    ] {
        let (total,complete,failed): (i64,i64,i64)=connection.query_row("SELECT COUNT(*),COALESCE(SUM(state='complete'),0),COALESCE(SUM(state='failed'),0) FROM memory_vector_units WHERE job_id=?1 AND record_kind=?2 AND state!='superseded'",params![job,kind],|row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(db_error)?;
        let state = StageWrite::vector_progress(complete, total, failed);
        connection.execute(&format!("UPDATE memory_projection_jobs SET {column}=?1,last_served_at=?2 WHERE job_id=?3"),params![state.json()?,now,job]).map_err(db_error)?;
    }
    Ok(())
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}

impl super::GraphRepository {
    pub(in crate::cognition) fn claim_vector_quantum(
        &mut self,
        now: &str,
    ) -> CognitionResult<Vec<ClaimedVectorUnit>> {
        claim(self.connection_mut()?, now)
    }

    pub(in crate::cognition) fn current_vector_candidate(
        &self,
        generation: &str,
        hit: &crate::cognition::recall::RecallVectorMatch,
    ) -> CognitionResult<bool> {
        current_candidate(self.connection()?, generation, hit)
    }

    pub(in crate::cognition) fn assert_vector_quantum_current(
        &self,
        generation: &str,
        units: &[ClaimedVectorUnit],
    ) -> CognitionResult<()> {
        assert_current(self.connection()?, generation, units)
    }

    pub(in crate::cognition) fn mark_vector_invoked(
        &mut self,
        units: &[ClaimedVectorUnit],
    ) -> CognitionResult<()> {
        invoked(self.connection_mut()?, units)
    }

    pub(in crate::cognition) fn mark_vector_received(
        &mut self,
        units: &[ClaimedVectorUnit],
    ) -> CognitionResult<()> {
        received(self.connection_mut()?, units)
    }

    pub(in crate::cognition) fn complete_vector_quantum(
        &mut self,
        units: &[ClaimedVectorUnit],
        receipt: &str,
        now: &str,
    ) -> CognitionResult<()> {
        complete(self.connection_mut()?, units, receipt, now)
    }

    pub(in crate::cognition) fn fail_vector_quantum(
        &mut self,
        units: &[ClaimedVectorUnit],
        code: &str,
        now: &str,
    ) -> CognitionResult<()> {
        fail(self.connection_mut()?, units, code, now)
    }
}
