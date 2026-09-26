
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
