//! Transactional consumption of stale typed-source lifecycle notices.

use rusqlite::{Connection, params};

use super::{GraphRepository, db_error};
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
        serde_json::to_string(value)
            .map_err(|error| CognitionError::new("memory_graph_unavailable", error.to_string()))
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
    CognitionError::new("memory_source_changed", "memory_source_changed")
}

#[cfg(test)]
mod tests;
