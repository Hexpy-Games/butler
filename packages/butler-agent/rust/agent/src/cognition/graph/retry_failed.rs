//! Source-compatible recovery for failed graph projection work.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::db_error;
use crate::cognition::{CognitionError, CognitionResult, generation_vectors::GenerationVectorRow};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(in crate::cognition) struct RetryFailedCounts {
    pub(in crate::cognition) semantic_windows: usize,
    pub(in crate::cognition) vector_units: usize,
    pub(in crate::cognition) cache_jobs: usize,
}

#[derive(Clone, Debug, Deserialize)]
pub(in crate::cognition) struct VectorRepairRequest {
    pub(in crate::cognition) generation_id: String,
    pub(in crate::cognition) units: Vec<VectorRepairUnitRequest>,
}

#[derive(Clone, Debug, Deserialize)]
pub(in crate::cognition) struct VectorRepairUnitRequest {
    pub(in crate::cognition) unit_id: String,
    pub(in crate::cognition) owner_revision: String,
    pub(in crate::cognition) source_revision: String,
    pub(in crate::cognition) receipt_json: String,
}

impl VectorRepairRequest {
    pub(in crate::cognition) fn parse(value: Value) -> CognitionResult<Self> {
        let request: Self = serde_json::from_value(value)
            .map_err(|_| error("memory_vector_repair_invalid_request"))?;
        if request.generation_id.is_empty()
            || request.units.is_empty()
            || request.units.iter().any(|unit| {
                unit.unit_id.is_empty()
                    || unit.owner_revision.is_empty()
                    || unit.source_revision.is_empty()
                    || unit.receipt_json.is_empty()
            })
        {
            return Err(error("memory_vector_repair_invalid_request"));
        }
        let mut ids = HashSet::with_capacity(request.units.len());
        if request
            .units
            .iter()
            .any(|unit| !ids.insert(unit.unit_id.as_str()))
        {
            return Err(error("memory_vector_repair_invalid_request"));
        }
        Ok(request)
    }
}

#[derive(Debug)]
struct RepairUnitSnapshot {
    unit_id: String,
    job_id: String,
    record_kind: String,
    owner_id: String,
    owner_revision: String,
    source_revision: String,
    projection_text: String,
    receipt_json: Option<String>,
    state: String,
    source_kind: Option<String>,
    source_observed_at: Option<String>,
    source_membership_invalid: i64,
}

/// Reset failed units and cache stages without spending or erasing prior attempts.
pub(super) fn retry_failed(
    connection: &mut Connection,
    generation_id: &str,
    now: &str,
) -> CognitionResult<RetryFailedCounts> {
    let recovery_revision = recovery_revision(generation_id, now)?;
    let cache_state = stringify(&json!({
        "state": "pending",
        "blocked_by": "memory_retry_requested"
    }))?;

    let tx = connection.transaction().map_err(db_error)?;
    let semantic_windows = tx
        .execute(
            "UPDATE memory_projection_windows SET \
             state=CASE WHEN normalized_plan_json IS NOT NULL THEN 'planned' ELSE 'pending' END,\
             error_code=NULL,next_attempt_at=NULL,owner_pid=NULL,owner_nonce=NULL,started_at=NULL,\
             recovery_revision=?1,recovery_base_attempt_count=attempt_count WHERE state='failed'",
            [&recovery_revision],
        )
        .map_err(db_error)?;
    let vector_units = tx
        .execute(
            "UPDATE memory_vector_units SET state='pending',error_code=NULL,next_attempt_at=NULL,\
             owner_pid=NULL,owner_nonce=NULL,started_at=NULL \
             WHERE state='failed' AND receipt_json IS NULL AND outcome_known=1",
            [],
        )
        .map_err(db_error)?;
    let cache_jobs = tx
        .execute(
            "UPDATE memory_projection_jobs SET hot_cache_state=?1,hot_cache_next_attempt_at=NULL,\
             hot_cache_owner_pid=NULL,hot_cache_owner_nonce=NULL,hot_cache_started_at=NULL \
             WHERE json_extract(hot_cache_state,'$.state')='failed'",
            [&cache_state],
        )
        .map_err(db_error)?;
    tx.commit().map_err(db_error)?;

    Ok(RetryFailedCounts {
        semantic_windows,
        vector_units,
        cache_jobs,
    })
}

/// Validate every requested preimage before performing any explicit vector repair.
/// The transaction makes the row resets and their parent job updates all-or-none.
pub(super) fn repair_selected_invalid_vectors(
    connection: &mut Connection,
    current_generation: &str,
    embedding_version: &str,
    request: &VectorRepairRequest,
) -> CognitionResult<usize> {
    if current_generation.is_empty()
        || embedding_version.is_empty()
        || request.generation_id != current_generation
        || request.units.is_empty()
    {
        return Err(error("memory_vector_repair_preimage_changed"));
    }

    let mut snapshots = Vec::with_capacity(request.units.len());
    for requested in &request.units {
        let snapshot = read_repair_unit(connection, requested, current_generation)?
            .ok_or_else(|| error("memory_vector_repair_preimage_changed"))?;
        if snapshot.state != "complete"
            || snapshot.owner_revision != requested.owner_revision
            || snapshot.source_revision != requested.source_revision
            || snapshot.receipt_json.as_deref() != Some(requested.receipt_json.as_str())
            || snapshot.source_membership_invalid != 0
            || snapshot.source_kind.as_deref().is_none_or(str::is_empty)
            || snapshot
                .source_observed_at
                .as_deref()
                .is_none_or(str::is_empty)
            || !completed_receipt_lacks_expected_identity(
                &snapshot,
                current_generation,
                embedding_version,
                &requested.receipt_json,
            )
        {
            return Err(error("memory_vector_repair_preimage_changed"));
        }
        snapshots.push(snapshot);
    }

    let tx = connection.transaction().map_err(db_error)?;
    for (requested, snapshot) in request.units.iter().zip(&snapshots) {
        let changed = tx
            .execute(
                "UPDATE memory_vector_units SET state='pending',error_code=NULL,\
                 next_attempt_at=NULL,owner_pid=NULL,owner_nonce=NULL,started_at=NULL,\
                 receipt_json=NULL,provider_invoked=0,outcome_known=1,invocation_ref=NULL \
                 WHERE unit_id=?1 AND state='complete' AND owner_revision=?2 AND receipt_json=?3 \
                   AND EXISTS(SELECT 1 FROM memory_projection_jobs current_job \
                     JOIN memory_chunks current_chunk \
                       ON current_chunk.memory_chunk_id=current_job.episode_id \
                       AND current_chunk.current_revision=current_job.revision \
                     WHERE current_job.job_id=memory_vector_units.job_id \
                       AND current_job.revision=?4 AND current_job.generation=?5)",
                params![
                    snapshot.unit_id,
                    requested.owner_revision,
                    requested.receipt_json,
                    requested.source_revision,
                    current_generation,
                ],
            )
            .map_err(db_error)?;
        if changed != 1 {
            return Err(error("memory_vector_repair_preimage_changed"));
        }
    }
    for snapshot in &snapshots {
        let column = if snapshot.record_kind == "node" {
            "node_vectors_state"
        } else {
            "episode_vectors_state"
        };
        tx.execute(
            &format!(
                "UPDATE memory_projection_jobs SET {column}=?1 WHERE job_id=?2 AND generation=?3"
            ),
            params![
                stringify(&json!({
                    "state": "pending",
                    "blocked_by": "memory_vector_repair_requested"
                }))?,
                snapshot.job_id,
                current_generation,
            ],
        )
        .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)?;
    Ok(snapshots.len())
}

fn read_repair_unit(
    connection: &Connection,
    requested: &VectorRepairUnitRequest,
    generation: &str,
) -> CognitionResult<Option<RepairUnitSnapshot>> {
    connection
        .query_row(
            "SELECT u.unit_id,u.job_id,u.record_kind,u.owner_id,u.owner_revision,j.revision,\
               u.projection_text,u.receipt_json,u.state, \
               (SELECT ordered.source_kind FROM memory_chunk_sources ordered \
                 WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision \
                 ORDER BY ordered.source_id LIMIT 1), \
               (SELECT ordered.observed_at FROM memory_chunk_sources ordered \
                 WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision \
                   AND ordered.source_id IN (SELECT value FROM json_each(u.source_ids_json)) \
                   AND (u.record_kind='episode' OR (ordered.origin_kind=u.origin_kind AND EXISTS( \
                     SELECT 1 FROM memory_evidence own \
                     WHERE own.source_id=ordered.source_id AND own.node_id=u.owner_id))) \
                 ORDER BY julianday(ordered.observed_at) DESC,ordered.source_id DESC LIMIT 1), \
               CASE WHEN NOT (u.project_id IS c.project_id) \
                 OR u.source_ids_json IS NULL OR json_array_length(u.source_ids_json)=0 \
                 OR EXISTS(SELECT 1 FROM json_each(u.source_ids_json) refs WHERE NOT EXISTS( \
                   SELECT 1 FROM memory_chunk_sources current_source \
                   WHERE current_source.source_id=refs.value \
                     AND current_source.episode_id=c.memory_chunk_id \
                     AND current_source.revision=c.current_revision \
                     AND (u.record_kind='episode' OR (current_source.origin_kind=u.origin_kind AND EXISTS( \
                       SELECT 1 FROM memory_evidence current_mention \
                       WHERE current_mention.node_id=u.owner_id \
                         AND current_mention.source_id=current_source.source_id \
                         AND current_mention.episode_id=c.memory_chunk_id \
                         AND current_mention.revision=c.current_revision))))) \
                 THEN 1 ELSE 0 END \
             FROM memory_vector_units u \
             JOIN memory_projection_jobs j ON j.job_id=u.job_id \
             JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision \
             WHERE u.unit_id=?1 AND j.generation=?2",
            params![requested.unit_id, generation],
            |row| {
                Ok(RepairUnitSnapshot {
                    unit_id: row.get(0)?,
                    job_id: row.get(1)?,
                    record_kind: row.get(2)?,
                    owner_id: row.get(3)?,
                    owner_revision: row.get(4)?,
                    source_revision: row.get(5)?,
                    projection_text: row.get(6)?,
                    receipt_json: row.get(7)?,
                    state: row.get(8)?,
                    source_kind: row.get(9)?,
                    source_observed_at: row.get(10)?,
                    source_membership_invalid: row.get(11)?,
                })
            },
        )
        .optional()
        .map_err(db_error)
}

fn completed_receipt_lacks_expected_identity(
    unit: &RepairUnitSnapshot,
    generation: &str,
    embedding_version: &str,
    receipt_json: &str,
) -> bool {
    let Ok(receipt) = serde_json::from_str::<Value>(receipt_json) else {
        return false;
    };
    if receipt.get("generation").and_then(Value::as_str) != Some(generation)
        || receipt.get("embedding_version").and_then(Value::as_str) != Some(embedding_version)
    {
        return false;
    }
    let Some(keys) = receipt.get("vector_keys").and_then(Value::as_array) else {
        return false;
    };
    let mut unique_keys = HashSet::with_capacity(keys.len());
    for key in keys {
        let Some(key) = key.as_str().filter(|key| !key.is_empty()) else {
            return false;
        };
        unique_keys.insert(key);
    }
    let Some(row_count) = receipt.get("row_count").and_then(Value::as_f64) else {
        return false;
    };
    if !row_count.is_finite() || row_count.fract() != 0.0 || row_count != unique_keys.len() as f64 {
        return false;
    }

    let (_, expected_key) = GenerationVectorRow::identity(
        generation,
        &unit.record_kind,
        &unit.owner_id,
        &unit.owner_revision,
        &unit.projection_text,
        embedding_version,
    );
    !unique_keys.contains(expected_key.as_str())
}

fn recovery_revision(generation_id: &str, now: &str) -> CognitionResult<String> {
    let source = stringify(&json!(["memory-retry-failed", generation_id, now]))?;
    Ok(format!("{:x}", Sha256::digest(source.as_bytes())))
}

fn stringify(value: &Value) -> CognitionResult<String> {
    crate::json::stringify(value).map_err(|_| error("memory_graph_failed"))
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
