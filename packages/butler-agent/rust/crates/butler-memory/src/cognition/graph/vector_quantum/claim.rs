//! Claiming pending vector units: one job's few units for live work, or a
//! large ordered batch across jobs for the daily window and backfill.

use super::*;

/// How much one claim takes.
#[derive(Clone, Copy, Debug)]
pub(in crate::cognition) struct ClaimLimit {
    /// Units claimed in all.
    pub units: usize,
    /// Distinct (job, record kind) groups they may come from.
    pub groups: usize,
}

impl ClaimLimit {
    /// Live work: up to four units of the next job and kind.
    pub(in crate::cognition) const LIVE: Self = Self {
        units: 4,
        groups: 1,
    };
    /// Daily and backfill batches: one claim, one vector write and one
    /// completion transaction per this many units.
    pub(in crate::cognition) const BATCH: Self = Self {
        units: 128,
        groups: 128,
    };
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
         ORDER BY u.unit_id LIMIT ?4";

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

/// Claims pending units whose semantic stage is complete, in due order and
/// within `limit`, marking the units and each job's vector stage running. One
/// transaction covers the whole claim.
pub(super) fn claim(
    connection: &mut Connection,
    now: &str,
    limit: ClaimLimit,
) -> CognitionResult<Vec<ClaimedVectorUnit>> {
    let tx = connection.transaction().map_err(db_error)?;
    recover(&tx)?;
    let groups = next_pending_groups(&tx, now, limit.groups)?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let mut statement = tx.prepare(PENDING_UNITS_SQL).map_err(db_error)?;
    let mut units = Vec::new();
    for (job, kind) in groups {
        let room = limit.units.saturating_sub(units.len());
        if room == 0 {
            break;
        }
        let selected = statement
            .query_map(params![job, kind, now, room], pending_unit)
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        let first = units.len();
        for pending in selected {
            units.push(claim_unit(&tx, pending, &nonce, now)?);
        }
        if let Some(first) = units.get(first) {
            mark_running(&tx, first, now)?;
        }
    }
    drop(statement);
    tx.commit().map_err(db_error)?;
    Ok(units)
}

/// Marks the vector stage of `first`'s job and kind running.
fn mark_running(tx: &Connection, first: &ClaimedVectorUnit, now: &str) -> CognitionResult<()> {
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
    Ok(())
}

/// The job and record kind of the next due pending units, in one scan.
fn next_pending_groups(
    tx: &Connection,
    now: &str,
    limit: usize,
) -> CognitionResult<Vec<(String, String)>> {
    let mut statement = tx
        .prepare(
            "SELECT u.job_id,u.record_kind FROM memory_vector_units u \
             JOIN memory_projection_jobs j ON j.job_id=u.job_id \
             JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision \
             WHERE u.state='pending' AND json_extract(j.semantic_graph_state,'$.state')='complete' \
               AND (u.next_attempt_at IS NULL OR u.next_attempt_at<=?1) \
             GROUP BY u.job_id,u.record_kind \
             ORDER BY j.last_served_at IS NOT NULL,j.last_served_at,j.created_at,j.job_id,MIN(u.unit_id) LIMIT ?2",
        )
        .map_err(db_error)?;
    statement
        .query_map(params![now, limit], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
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
