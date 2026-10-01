//! Projection job records: registration replay, catch-up cursors, the next
//! pending semantic job, and a job's progress across its stages.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde::de::IgnoredAny;

use super::db_error;
use super::stage_state::{StageState, StageStatus, StageWrite};
use crate::cognition::CognitionCode;
use crate::cognition::{
    CognitionError, CognitionResult, ConversationSourceNotice, assert_conversation_source_current,
};
use butler_turn::conversation::ConversationSourceReader;

/// Where one projection job stands across its stages.
#[derive(Clone, Debug, PartialEq)]
pub struct GraphProgress {
    /// The job.
    pub job_id: String,
    /// Completion jobs that observed this revision.
    pub observed_completion_job_ids: Vec<String>,
    /// The projected episode.
    pub episode_id: String,
    /// The projected revision.
    pub revision: String,
    /// Extractor version of the job.
    pub extraction_version: String,
    /// Generation the job belongs to.
    pub generation: String,
    /// Source registration stage.
    pub source: StageState,
    /// Semantic graph stage.
    pub semantic_graph: StageState,
    /// Episode vector stage.
    pub episode_vectors: StageState,
    /// Node vector stage.
    pub node_vectors: StageState,
    /// Hot-cache stage.
    pub hot_cache: StageState,
    /// Overall outcome of the job.
    pub outcome: JobOutcome,
}

/// Overall outcome of a projection job.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobOutcome {
    /// A newer revision replaced the job's revision.
    Superseded,
    /// Every stage is complete.
    Complete,
    /// Sources are not yet registered.
    Pending,
    /// Sources are registered; later stages remain.
    Partial,
}

#[derive(Clone, Debug)]
pub(in crate::cognition) struct PendingSemanticJob {
    pub job_id: String,
    pub session_id: Option<String>,
    pub source_key: String,
    pub source_hash: String,
    pub extraction_version: String,
}

/// Where canonical catch-up stands, including the source binding for cursors.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(in crate::cognition) struct CatchupState {
    pub outcome: Option<String>,
    pub message: Option<String>,
    /// Canonical public revision at which the current sweep began.
    pub sweep_revision: Option<u64>,
    pub source_identity: Option<String>,
    /// The current sweep has reached the end of both inventories.
    pub sweep_done: bool,
    /// Epoch milliseconds at which the last sweep completed.
    pub swept_at_ms: Option<i64>,
}

const OUTCOME_CURSOR: &str = "canonical_catchup_outcome_cursor";
const MESSAGE_CURSOR: &str = "canonical_catchup_message_cursor";
const SWEEP_REVISION: &str = "canonical_catchup_sweep_revision";
const SOURCE_IDENTITY: &str = "canonical_catchup_source_identity";
const SWEEP_DONE: &str = "canonical_catchup_sweep_done";
const SWEPT_AT: &str = "canonical_catchup_swept_at_ms";

pub(super) fn catchup_state(connection: &Connection) -> CognitionResult<CatchupState> {
    let read = |key| -> CognitionResult<Option<String>> {
        connection
            .query_row(
                "SELECT value FROM memory_state WHERE key=?1",
                [key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map(|value| value.filter(|item| !item.is_empty()))
            .map_err(db_error)
    };
    Ok(CatchupState {
        outcome: read(OUTCOME_CURSOR)?,
        message: read(MESSAGE_CURSOR)?,
        sweep_revision: read(SWEEP_REVISION)?.and_then(|value| value.parse().ok()),
        source_identity: read(SOURCE_IDENTITY)?,
        sweep_done: read(SWEEP_DONE)?.as_deref() == Some("1"),
        swept_at_ms: read(SWEPT_AT)?.and_then(|value| value.parse().ok()),
    })
}

pub(super) fn save_catchup_state(
    connection: &mut Connection,
    state: &CatchupState,
) -> CognitionResult<()> {
    let transaction = connection.transaction().map_err(db_error)?;
    for (key, value) in [
        (OUTCOME_CURSOR, state.outcome.clone().unwrap_or_default()),
        (MESSAGE_CURSOR, state.message.clone().unwrap_or_default()),
        (
            SWEEP_REVISION,
            state
                .sweep_revision
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
        (SWEEP_DONE, u8::from(state.sweep_done).to_string()),
        (
            SOURCE_IDENTITY,
            state.source_identity.clone().unwrap_or_default(),
        ),
        (
            SWEPT_AT,
            state
                .swept_at_ms
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
    ] {
        transaction.execute(
            "INSERT INTO memory_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        ).map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)
}

/// The observation ids among `ids` that a registered job already recorded.
/// The jobs table is small next to the memory graph, so one pass over its
/// observation lists answers the whole batch.
pub(super) fn registered_observations(
    connection: &Connection,
    ids: &[String],
) -> CognitionResult<HashSet<String>> {
    let mut found = HashSet::new();
    for batch in ids.chunks(256) {
        let marks = vec!["?"; batch.len()].join(",");
        let mut statement = connection
            .prepare(&format!(
                "SELECT DISTINCT observed.value FROM memory_projection_jobs j, \
                 json_each(j.observed_completion_job_ids) observed \
                 WHERE observed.value IN ({marks})"
            ))
            .map_err(db_error)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(batch), |row| {
                row.get::<_, String>(0)
            })
            .map_err(db_error)?;
        for row in rows {
            found.insert(row.map_err(db_error)?);
        }
    }
    Ok(found)
}

/// The next job with a due semantic window. The scan starts from the windows
/// still waiting (`idx_windows_due`), so an idle graph costs a few index
/// probes however many finished jobs it holds.
pub(super) fn pending_semantic(
    connection: &Connection,
    now: &str,
) -> CognitionResult<Option<PendingSemanticJob>> {
    connection.query_row(
        "SELECT j.job_id,c.conversation_session_id,c.source_key,c.source_hash,j.extraction_version
         FROM memory_projection_windows w
         JOIN memory_projection_jobs j ON j.job_id=w.job_id
         JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
         WHERE w.state IN ('pending','planned') AND w.owner_nonce IS NULL
           AND (w.state='planned' OR w.output_json IS NOT NULL OR (
             SELECT COUNT(DISTINCT a.invocation_ref) FROM memory_projection_attempts a
             WHERE a.window_ref=w.window_ref AND a.provider_invoked=1
               AND a.recovery_revision IS w.recovery_revision) < 3)
           AND (w.next_attempt_at IS NULL OR w.next_attempt_at<=?1)
         GROUP BY j.job_id
         ORDER BY j.last_served_at IS NOT NULL,j.last_served_at,j.created_at,j.job_id LIMIT 1",
        [now],
        |row| Ok(PendingSemanticJob {
            job_id: row.get(0)?, session_id: row.get(1)?, source_key: row.get(2)?,
            source_hash: row.get(3)?, extraction_version: row.get(4)?,
        }),
    ).optional().map_err(db_error)
}

pub(super) fn replay(
    connection: &mut Connection,
    canonical: &ConversationSourceReader,
    notice: ConversationSourceNotice<'_>,
    episode_id: &str,
    revision: &str,
    completion_id: Option<&str>,
    now: &str,
) -> CognitionResult<Option<String>> {
    let tx = connection.transaction().map_err(db_error)?;
    assert_conversation_source_current(canonical, notice, revision, now)?;
    let mut statement = tx
        .prepare(
            "SELECT j.job_id,j.observed_completion_job_ids FROM memory_projection_jobs j \
         JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision \
         WHERE j.episode_id=?1 AND j.revision=?2",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![episode_id, revision], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(statement);
    if rows.len() > 1 {
        return Err(CognitionError::new(
            CognitionCode::MemoryProjectionDuplicateRevision,
            "memory_projection_duplicate_revision",
        ));
    }
    let Some((job_id, encoded)) = rows.into_iter().next() else {
        tx.commit().map_err(db_error)?;
        return Ok(None);
    };
    let mut ids: Vec<String> = serde_json::from_str(&encoded).map_err(|error| {
        CognitionError::new(CognitionCode::MemoryGraphUnavailable, error.to_string())
            .with_source(error)
    })?;
    if let Some(id) = completion_id.filter(|value| !value.is_empty())
        && !ids.iter().any(|value| value == id)
    {
        ids.push(id.to_owned());
        ids.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        tx.execute(
            "UPDATE memory_projection_jobs SET observed_completion_job_ids=?1 WHERE job_id=?2",
            params![
                serde_json::to_string(&ids).map_err(|error| {
                    CognitionError::new(CognitionCode::MemoryGraphUnavailable, error.to_string())
                        .with_source(error)
                })?,
                job_id
            ],
        )
        .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)?;
    Ok(Some(job_id))
}

pub(super) fn progress(connection: &Connection, job_id: &str) -> CognitionResult<GraphProgress> {
    let row = connection.query_row("SELECT j.job_id,j.observed_completion_job_ids,j.episode_id,j.revision,j.extraction_version,j.generation,j.source_state,j.semantic_graph_state,j.episode_vectors_state,j.node_vectors_state,j.hot_cache_state,c.current_revision FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE j.job_id=?1", [job_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,String>(8)?,row.get::<_,String>(9)?,row.get::<_,String>(10)?,row.get::<_,String>(11)?))).optional().map_err(db_error)?;
    let Some((
        job_id,
        ids,
        episode_id,
        revision,
        extraction_version,
        generation,
        source,
        semantic,
        episode_vectors,
        node_vectors,
        hot_cache,
        current,
    )) = row
    else {
        return Err(CognitionError::new(
            CognitionCode::MemoryProjectionJobNotFound,
            "memory_projection_job_not_found",
        ));
    };
    let parse = |value: &str| {
        serde_json::from_str::<IgnoredAny>(value).map_err(|error| {
            CognitionError::new(CognitionCode::MemoryGraphUnavailable, error.to_string())
                .with_source(error)
        })?;
        Ok::<_, CognitionError>(StageState::parse(value))
    };
    let stages = [
        parse(&source)?,
        parse(&semantic)?,
        parse(&episode_vectors)?,
        parse(&node_vectors)?,
        parse(&hot_cache)?,
    ];
    let outcome = if current != revision {
        JobOutcome::Superseded
    } else if stages.iter().all(StageState::is_complete) {
        JobOutcome::Complete
    } else if !stages[0].is_complete() {
        JobOutcome::Pending
    } else {
        JobOutcome::Partial
    };
    let observed_completion_job_ids = serde_json::from_str(&ids).map_err(|error| {
        CognitionError::new(CognitionCode::MemoryGraphUnavailable, error.to_string())
            .with_source(error)
    })?;
    let [
        source,
        semantic_graph,
        episode_vectors,
        node_vectors,
        hot_cache,
    ] = stages;
    Ok(GraphProgress {
        job_id,
        observed_completion_job_ids,
        episode_id,
        revision,
        extraction_version,
        generation,
        source,
        semantic_graph,
        episode_vectors,
        node_vectors,
        hot_cache,
        outcome,
    })
}

pub(super) fn refresh_semantic_state(
    connection: &Connection,
    job_id: &str,
    now: &str,
) -> CognitionResult<()> {
    let (total,complete,failed,warnings)=connection.query_row("SELECT COUNT(*),COALESCE(SUM(state='complete'),0),COALESCE(SUM(state='failed'),0),COALESCE(SUM(state='unsupported'),0) FROM memory_projection_windows WHERE job_id=?1 AND state!='replaced'",[job_id],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?,row.get::<_,i64>(3)?))).map_err(db_error)?;
    let state = if complete == total {
        StageWrite::complete(complete)
    } else if complete > 0 || failed > 0 || warnings > 0 {
        StageWrite::Partial {
            completed_units: complete,
            total_units: total,
            pending_units: (total - complete - failed - warnings).max(0),
            failed_units: failed,
            warning_units: (warnings > 0).then_some(warnings),
        }
    } else {
        StageWrite::pending()
    };
    connection.execute("UPDATE memory_projection_jobs SET semantic_graph_state=?1,last_served_at=?2 WHERE job_id=?3",params![state.json()?,now,job_id]).map_err(db_error)?;
    if complete + warnings == total {
        let nodes: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM memory_vector_units WHERE job_id=?1 AND record_kind='node'",
                [job_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if nodes == 0 {
            let current: Option<String> = connection
                .query_row(
                    "SELECT node_vectors_state FROM memory_projection_jobs WHERE job_id=?1",
                    [job_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?;
            if current
                .as_deref()
                .map(StageState::parse)
                .and_then(|stage| stage.state)
                != Some(StageStatus::NotConfigured)
            {
                connection
                    .execute(
                        "UPDATE memory_projection_jobs SET node_vectors_state=?1 WHERE job_id=?2",
                        params![StageWrite::complete(0).json()?, job_id],
                    )
                    .map_err(db_error)?;
            }
        }
    }
    Ok(())
}
