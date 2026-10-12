//! Durable claim and receipt transitions for current vector units.

use crate::cognition::CognitionCode;
use crate::cognition::graph::StageWrite;
use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::db_error;
use crate::cognition::{CognitionError, CognitionResult};
mod claim;
mod recovery;
pub(in crate::cognition) use claim::ClaimLimit;
use claim::claim;
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

/// Completes the units, each with its own receipt, in one transaction.
pub(super) fn complete(
    connection: &mut Connection,
    units: &[ClaimedVectorUnit],
    receipts: &[String],
    now: &str,
) -> CognitionResult<()> {
    if units.is_empty() || receipts.len() != units.len() {
        return Err(error(CognitionCode::MemoryVectorBatchLimit));
    }
    let tx = connection.transaction().map_err(db_error)?;
    for (unit, receipt) in units.iter().zip(receipts) {
        if tx.execute("UPDATE memory_vector_units SET state='complete',error_code=NULL,owner_pid=NULL,owner_nonce=NULL,started_at=NULL,receipt_json=?1,outcome_known=1 WHERE unit_id=?2 AND owner_nonce=?3 AND state='running'", params![receipt,unit.unit_id,unit.owner_nonce]).map_err(db_error)? !=1 {
            return Err(error(CognitionCode::MemoryVectorUnitChanged));
        }
    }
    refresh_jobs(&tx, units, now)?;
    tx.commit().map_err(db_error)
}

/// Ends an attempt that never produced a vector and says nothing about the
/// unit: the worker was cold, or the attempt was cancelled (the model switched
/// off, the service quit, a batch stopped early). Vectors come only from the
/// local deterministic model, so a retry has no side effect and returns the
/// same vector; such a unit stays pending without an error, delay or attempt.
fn deferred(code: &str) -> bool {
    matches!(
        code,
        "embed_worker_cold"
            | "embed_request_cancelled"
            | "embed_owner_closed"
            | "memory_write_aborted"
            | "memory_operation_aborted"
            | "memory_sync_closed"
    )
}

/// Returns claimed units that were never attempted to pending, as deferred.
pub(super) fn defer(
    connection: &mut Connection,
    units: &[ClaimedVectorUnit],
    now: &str,
) -> CognitionResult<()> {
    fail(connection, units, "embed_request_cancelled", now)
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
        let deferred = deferred(code);
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
    refresh_jobs(&tx, units, now)?;
    tx.commit().map_err(db_error)
}

/// Refreshes the vector stages of every job the units belong to, once each.
fn refresh_jobs(tx: &Connection, units: &[ClaimedVectorUnit], now: &str) -> CognitionResult<()> {
    let mut jobs = HashSet::new();
    for unit in units {
        if jobs.insert(unit.job_id.as_str()) {
            refresh(tx, &unit.job_id, now)?;
        }
    }
    Ok(())
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
        limit: ClaimLimit,
    ) -> CognitionResult<Vec<ClaimedVectorUnit>> {
        claim(self.connection_mut()?, now, limit)
    }

    pub(in crate::cognition) fn defer_vector_quantum(
        &mut self,
        units: &[ClaimedVectorUnit],
        now: &str,
    ) -> CognitionResult<()> {
        defer(self.connection_mut()?, units, now)
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
        receipts: &[String],
        now: &str,
    ) -> CognitionResult<()> {
        complete(self.connection_mut()?, units, receipts, now)
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
