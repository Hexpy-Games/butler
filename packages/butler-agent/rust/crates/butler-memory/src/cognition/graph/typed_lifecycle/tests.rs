use rusqlite::Connection;

use super::{TypedLifecycleInput, consume};
use crate::cognition::sources::TypedMemoryLifecycle;

#[test]
fn lifecycle_consumption_updates_only_matching_revision_and_records_disposition() {
    let mut connection = Connection::open_in_memory().unwrap();
    crate::cognition::graph::schema::ensure(&mut connection, "now").unwrap();
    connection.execute_batch("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,origin_kind,status,source_hash,created_at,updated_at) VALUES('task','task_report:task-a','new-revision','user_input','active','hash','old','old'),('rule','explicit_record:rule-a','old-revision','user_input','active','hash','old','old');
    INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) VALUES('job','rule','old-revision','v3','g','stub','low','[]','{}','{\"state\":\"complete\"}','{}','{}','{\"state\":\"complete\"}','old');").unwrap();

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
    let cache_state: String = connection
        .query_row(
            "SELECT hot_cache_state FROM memory_projection_jobs WHERE job_id='job'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&cache_state).unwrap()["state"],
        "pending"
    );
    super::super::cache_work::tests::assert_query_plan();
}
