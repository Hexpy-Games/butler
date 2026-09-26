//! Transactional consumption of stale typed-source lifecycle notices.

use rusqlite::{Connection, params};

use super::{GraphRepository, db_error};
use crate::cognition::{CognitionError, CognitionResult, sources::TypedMemoryLifecycle};

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
    if input.disposition == TypedMemoryLifecycle::Current {
        return Err(source_changed());
    }
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
        TypedMemoryLifecycle::Current => unreachable!(),
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
mod tests {
    use rusqlite::Connection;

    use super::{TypedLifecycleInput, consume};
    use crate::cognition::sources::TypedMemoryLifecycle;

    #[test]
    fn lifecycle_consumption_updates_only_matching_revision_and_records_disposition() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE memory_chunks(source_key TEXT PRIMARY KEY,current_revision TEXT NOT NULL,status TEXT NOT NULL,updated_at TEXT NOT NULL);\
                 CREATE TABLE memory_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);\
                 INSERT INTO memory_chunks VALUES('task_report:task-a','new-revision','active','old');\
                 INSERT INTO memory_chunks VALUES('explicit_record:rule-a','old-revision','active','old');",
            )
            .unwrap();

        consume(
            &mut connection,
            TypedLifecycleInput {
                source_kind: "task_report",
                record_id: "task-a",
                revision: "old-revision",
                operation_id: "operation-a",
                disposition: TypedMemoryLifecycle::Superseded,
                now: "now",
            },
        )
        .unwrap();
        consume(
            &mut connection,
            TypedLifecycleInput {
                source_kind: "explicit_record",
                record_id: "rule-a",
                revision: "forgotten-revision",
                operation_id: "operation-b",
                disposition: TypedMemoryLifecycle::Forgotten,
                now: "now",
            },
        )
        .unwrap();

        let task: (String, String) = connection
            .query_row(
                "SELECT current_revision,status FROM memory_chunks WHERE source_key='task_report:task-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let rule: (String, String) = connection
            .query_row(
                "SELECT current_revision,status FROM memory_chunks WHERE source_key='explicit_record:rule-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(task, ("new-revision".into(), "active".into()));
        assert_eq!(rule, ("forgotten-revision".into(), "forgotten".into()));

        let state: String = connection
            .query_row(
                "SELECT value FROM memory_state WHERE key='typed_lifecycle:operation-b'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&state).unwrap(),
            serde_json::json!({
                "disposition": "forgotten",
                "source_kind": "explicit_record",
                "record_id": "rule-a",
                "revision": "forgotten-revision"
            })
        );
    }
}
