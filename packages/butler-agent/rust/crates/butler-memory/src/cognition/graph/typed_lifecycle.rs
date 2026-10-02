//! Transactional consumption of stale typed-source lifecycle notices.

use rusqlite::{Connection, params};

use super::{GraphRepository, db_error};
use crate::cognition::CognitionCode;
use crate::cognition::{CognitionError, CognitionResult, sources::TypedMemoryLifecycle};

#[derive(Clone, Copy)]
pub(in crate::cognition) struct TypedLifecycleInput<'a> {
    pub source_kind: &'a str,
    pub record_id: &'a str,
    pub revision: &'a str,
    pub operation_id: &'a str,
    pub disposition: TypedMemoryLifecycle,
    pub now: &'a str,
}

impl GraphRepository {
    /// Targeted semantic readiness for a committed active rule revision.
    pub(in crate::cognition) fn rule_projection_ready(
        &self,
        record: &str,
        revision: &str,
    ) -> CognitionResult<bool> {
        self.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision WHERE c.source_key=?1 AND c.current_revision=?2 AND c.status='active' AND json_extract(j.semantic_graph_state,'$.state')='complete')",
            params![format!("explicit_record:{record}"),revision], |row| row.get(0)).map_err(db_error)
    }

    pub(in crate::cognition) fn consume_typed_lifecycle(
        &mut self,
        input: TypedLifecycleInput<'_>,
    ) -> CognitionResult<()> {
        consume(self.connection_mut()?, input)
    }
}

fn consume(connection: &mut Connection, input: TypedLifecycleInput<'_>) -> CognitionResult<()> {
    let transaction = connection.transaction().map_err(db_error)?;
    let source_key = format!("{}:{}", input.source_kind, input.record_id);
    match input.disposition {
        TypedMemoryLifecycle::Forgotten => {
            transaction
                .execute(
                    "UPDATE memory_chunks SET current_revision=?1,status='forgotten',updated_at=?2 WHERE source_key=?3",
                    params![input.revision, input.now, source_key],
                )
                .map_err(db_error)?;
        }
        TypedMemoryLifecycle::Superseded => {
            transaction
                .execute(
                    "UPDATE memory_chunks SET status='superseded',updated_at=?1 WHERE source_key=?2 AND current_revision=?3",
                    params![input.now, source_key, input.revision],
                )
                .map_err(db_error)?;
        }
        TypedMemoryLifecycle::Current => return Err(source_changed()),
    }
    transaction.execute("UPDATE memory_projection_jobs SET hot_cache_state=?1,hot_cache_next_attempt_at=NULL,hot_cache_attempt_count=0 WHERE episode_id IN (SELECT memory_chunk_id FROM memory_chunks WHERE source_key=?2 AND status!='active')", params![super::StageWrite::pending().json()?,source_key]).map_err(db_error)?;
    let state = lifecycle_state_json(&input)?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO memory_state(key,value) VALUES(?1,?2)",
            params![format!("typed_lifecycle:{}", input.operation_id), state],
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)
}

fn lifecycle_state_json(input: &TypedLifecycleInput<'_>) -> CognitionResult<String> {
    let disposition = match input.disposition {
        TypedMemoryLifecycle::Superseded => "superseded",
        TypedMemoryLifecycle::Forgotten => "forgotten",
        TypedMemoryLifecycle::Current => return Err(source_changed()),
    };
    let encode = |value: &str| {
        serde_json::to_string(value).map_err(|error| {
            CognitionError::new(CognitionCode::MemoryGraphUnavailable, error.to_string())
                .with_source(error)
        })
    };
    Ok(format!(
        "{{\"disposition\":{},\"source_kind\":{},\"record_id\":{},\"revision\":{}}}",
        encode(disposition)?,
        encode(input.source_kind)?,
        encode(input.record_id)?,
        encode(input.revision)?,
    ))
}

fn source_changed() -> CognitionError {
    CognitionError::new(CognitionCode::MemorySourceChanged, "memory_source_changed")
}

#[cfg(test)]
mod tests;
