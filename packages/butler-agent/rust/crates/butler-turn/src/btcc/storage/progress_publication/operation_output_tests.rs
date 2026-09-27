use base64::Engine;
use rusqlite::{Connection, params};
use serde_json::json;

use super::read_child_operation_output_events;

#[test]
fn child_output_read_is_relation_bound_public_and_exact_result_scoped() {
    let connection = output_database();
    connection
        .execute(
            "INSERT INTO btcc_turns(turn_id,session_id) VALUES('child-turn','child-session')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO btcc_turns(turn_id,session_id) VALUES('unrelated-turn','unrelated-session')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO btcc_session_relations(child_session_id) VALUES('child-session')",
            [],
        )
        .unwrap();

    for event in [
        EventSpec {
            turn_id: "child-turn",
            session_id: "child-session",
            event_id: "public-matching-result",
            visibility: "public",
            request_id: "request-1",
            result_id: "result-1",
            output: "public output",
        },
        EventSpec {
            turn_id: "child-turn",
            session_id: "child-session",
            event_id: "private-matching-result",
            visibility: "internal",
            request_id: "request-1",
            result_id: "result-1",
            output: "private output",
        },
        EventSpec {
            turn_id: "child-turn",
            session_id: "child-session",
            event_id: "public-other-result",
            visibility: "public",
            request_id: "request-1",
            result_id: "other-result",
            output: "other output",
        },
        EventSpec {
            turn_id: "child-turn",
            session_id: "child-session",
            event_id: "private-only-result",
            visibility: "internal",
            request_id: "request-1",
            result_id: "private-result",
            output: "private only",
        },
        EventSpec {
            turn_id: "unrelated-turn",
            session_id: "unrelated-session",
            event_id: "unrelated-public-result",
            visibility: "public",
            request_id: "request-1",
            result_id: "result-1",
            output: "unrelated output",
        },
    ] {
        insert_event(&connection, event);
    }
    connection
        .execute(
            "INSERT INTO btcc_progress_events(event_id,session_id,turn_id,turn_sequence,event_json) \
             VALUES('malformed-event','child-session','child-turn',99,'{')",
            [],
        )
        .unwrap();

    let public =
        read_child_operation_output_events(&connection, "child-turn", "request-1", "result-1")
            .unwrap();
    assert_eq!(public.len(), 1);
    assert_eq!(
        public[0]["payload"]["contentBase64"],
        "cHVibGljIG91dHB1dA=="
    );

    assert!(
        read_child_operation_output_events(
            &connection,
            "child-turn",
            "request-1",
            "private-result",
        )
        .unwrap()
        .is_empty()
    );
    assert_eq!(
        read_child_operation_output_events(&connection, "child-turn", "request-1", "other-result")
            .unwrap()
            .len(),
        1
    );
    assert!(
        read_child_operation_output_events(&connection, "unrelated-turn", "request-1", "result-1",)
            .unwrap()
            .is_empty()
    );
}

fn output_database() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE btcc_turns(turn_id TEXT PRIMARY KEY,session_id TEXT NOT NULL);
             CREATE TABLE btcc_session_relations(child_session_id TEXT PRIMARY KEY);
             CREATE TABLE btcc_progress_events(
               event_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,
               turn_sequence INTEGER NOT NULL,event_json TEXT NOT NULL
             );",
        )
        .unwrap();
    connection
}

#[derive(Clone, Copy)]
struct EventSpec<'a> {
    turn_id: &'a str,
    session_id: &'a str,
    event_id: &'a str,
    visibility: &'a str,
    request_id: &'a str,
    result_id: &'a str,
    output: &'a str,
}

fn insert_event(connection: &Connection, input: EventSpec<'_>) {
    let bytes = input.output.as_bytes();
    let content_base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let content_sha256 = sha256(bytes);
    let event = json!({
        "kind":"operation.output.chunk",
        "visibility":input.visibility,
        "payload":{
            "requestId":input.request_id,
            "resultId":input.result_id,
            "resultSha256":"a".repeat(64),
            "chunkIndex":0,
            "chunkCount":1,
            "byteStart":0,
            "byteEnd":bytes.len(),
            "byteLength":bytes.len(),
            "contentBase64":content_base64,
            "contentSha256":content_sha256,
        }
    });
    let sequence: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM btcc_progress_events WHERE turn_id=?1",
            [input.turn_id],
            |row| row.get(0),
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO btcc_progress_events(event_id,session_id,turn_id,turn_sequence,event_json) \
             VALUES(?1,?2,?3,?4,?5)",
            params![
                input.event_id,
                input.session_id,
                input.turn_id,
                sequence,
                event.to_string()
            ],
        )
        .unwrap();
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
