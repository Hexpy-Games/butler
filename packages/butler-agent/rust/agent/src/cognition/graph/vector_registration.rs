//! Durable registration of vector work after the semantic graph is committed.

#[cfg(test)]
#[path = "vector_registration/tests.rs"]
mod tests;
mod units;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::path::Path;

use super::db_error;
use crate::cognition::{
    CognitionError, CognitionResult, CognitionSourceRow, hydrate_conversation_source,
    sources::hydrate_typed_source,
};
use crate::conversation::ConversationSourceReader;

const NODE_CHUNK_BYTES: usize = 4_096;
const EPISODE_CHUNK_BYTES: usize = 4_000;
const OVERSIZED_GRAPHEME: &str = "memory_vector_oversized_grapheme";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::cognition) struct EpisodeProjectionSource {
    pub(super) source_id: String,
    pub(super) text: String,
    pub(super) role: String,
    pub(super) byte_start: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::cognition) enum VectorRegistrationStage {
    Node,
    Episode,
}

#[derive(Debug)]
pub(in crate::cognition) struct VectorRegistrationFailure {
    pub(in crate::cognition) stage: VectorRegistrationStage,
    pub(in crate::cognition) error: CognitionError,
}

/// Read and hydrate the canonical source leaves for a current projection job.
pub(super) fn read_episode_projection(
    connection: &Connection,
    canonical: &ConversationSourceReader,
    source_root: &Path,
    job_id: &str,
) -> CognitionResult<Vec<EpisodeProjectionSource>> {
    let (episode_id, revision) = connection
        .query_row(
            "SELECT episode_id,revision FROM memory_projection_jobs WHERE job_id=?1",
            [job_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(job_not_found)?;
    connection
        .query_row(
            "SELECT 1 FROM memory_chunks WHERE memory_chunk_id=?1 AND current_revision=?2",
            params![episode_id, revision],
            |_| Ok(()),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(source_changed)?;

    let mut statement = connection
        .prepare(
            "SELECT source_id,episode_id,revision,source_kind,conversation_session_id,\
             conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,\
             role,origin_kind,observed_at,basis FROM memory_source_leaves \
             WHERE episode_id=?1 AND revision=?2 \
             ORDER BY observed_at,conversation_message_id,part_id,scalar_pointer,byte_start",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![episode_id, revision], source_row)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    rows.into_iter()
        .map(|row| {
            if matches!(row.source_kind.as_str(), "task_report" | "explicit_record") {
                return Ok(EpisodeProjectionSource {
                    source_id: row.source_id.clone(),
                    text: hydrate_typed_source(source_root, &row)?,
                    role: row.role.clone(),
                    byte_start: integer_byte_offset(row.byte_start)?,
                });
            }
            let message_id = row
                .conversation_message_id
                .as_deref()
                .ok_or_else(source_changed)?;
            let message = canonical
                .read_message(message_id)
                .map_err(conversation_error)?
                .ok_or_else(source_changed)?;
            let hydrated = hydrate_conversation_source(&message, &row, f64::INFINITY)?;
            let byte_start = integer_byte_offset(hydrated.byte_start)?;
            Ok(EpisodeProjectionSource {
                source_id: row.source_id.clone(),
                text: hydrated.text.to_owned(),
                role: row.role.clone(),
                byte_start,
            })
        })
        .collect()
}

/// Refresh node and episode units atomically. A returned failure means the
/// registration transaction rolled back and carries the stage that failed.
pub(super) fn refresh_vector_units_for_job(
    connection: &mut Connection,
    job_id: &str,
    episode_sources: &[EpisodeProjectionSource],
    now: &str,
) -> Result<(), VectorRegistrationFailure> {
    units::refresh(connection, job_id, episode_sources, now)
        .map_err(|(stage, error)| VectorRegistrationFailure { stage, error })
}

/// Mark one vector stage after a registration transaction has rolled back.
/// Semantic graph state is deliberately never changed here.
pub(super) fn mark_vector_registration_failure(
    connection: &Connection,
    job_id: &str,
    code: &str,
    stage: VectorRegistrationStage,
) -> CognitionResult<()> {
    let column = stage.column();
    let current = connection
        .query_row(
            &format!("SELECT {column} FROM memory_projection_jobs WHERE job_id=?1"),
            [job_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    let Some(current) = current else {
        return Ok(());
    };
    let current: Value = serde_json::from_str(&current).map_err(json_error)?;
    let current_state = current.get("state").and_then(Value::as_str);
    if matches!(current_state, Some("complete" | "not_configured")) {
        return Ok(());
    }
    let next = if code == "memory_write_busy" {
        json!({"state":"pending","blocked_by":code})
    } else {
        json!({"state":"failed","code":code,"retryable":false,"next_attempt_at":null})
    };
    connection
        .execute(
            &format!("UPDATE memory_projection_jobs SET {column}=?1 WHERE job_id=?2"),
            params![stringify(&next)?, job_id],
        )
        .map_err(db_error)?;
    Ok(())
}

impl VectorRegistrationStage {
    fn column(self) -> &'static str {
        match self {
            Self::Node => "node_vectors_state",
            Self::Episode => "episode_vectors_state",
        }
    }
}

pub(super) fn source_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CognitionSourceRow> {
    Ok(CognitionSourceRow {
        source_id: row.get(0)?,
        episode_id: row.get(1)?,
        revision: row.get(2)?,
        source_kind: row.get(3)?,
        conversation_session_id: row.get(4)?,
        conversation_message_id: row.get(5)?,
        part_id: row.get(6)?,
        scalar_pointer: row.get(7)?,
        byte_start: row.get(8)?,
        byte_end: row.get(9)?,
        content_hash: row.get(10)?,
        role: row.get(11)?,
        origin_kind: row.get(12)?,
        observed_at: row.get(13)?,
        basis: row.get(14)?,
    })
}

fn integer_byte_offset(value: f64) -> CognitionResult<i64> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > i64::MAX as f64 {
        Err(source_changed())
    } else {
        Ok(crate::json::saturating_i64(value))
    }
}

fn digest(values: Vec<Value>) -> CognitionResult<String> {
    crate::cognition::sources::projection_hash_for_graph(values).map_err(Into::into)
}

fn json_array(values: &[String]) -> CognitionResult<String> {
    stringify(&Value::Array(
        values.iter().cloned().map(Value::String).collect(),
    ))
}

fn json_string(value: Option<&str>) -> CognitionResult<String> {
    stringify(&value.map_or(Value::Null, |value| Value::String(value.to_owned())))
}

fn stringify(value: &Value) -> CognitionResult<String> {
    crate::json::stringify(value)
        .map_err(|error| CognitionError::new("memory_graph_unavailable", error.to_string()))
}

fn option_value(value: Option<&str>) -> Value {
    value.map_or(Value::Null, |value| Value::String(value.to_owned()))
}

fn conversation_error(error: crate::conversation::ConversationError) -> CognitionError {
    CognitionError::new(error.code, error.message)
}

fn json_error(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_graph_unavailable", error.to_string())
}

fn job_not_found() -> CognitionError {
    CognitionError::new(
        "memory_projection_job_not_found",
        "memory_projection_job_not_found",
    )
}

fn source_changed() -> CognitionError {
    CognitionError::new("memory_source_changed", "memory_source_changed")
}
