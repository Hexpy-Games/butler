use base64::Engine;
use rusqlite::Connection;
use serde_json::json;

use super::chunk::sha256;
use super::{
    AppOutputRead, OUTPUT_PAGE_BYTES, OperationOutputChunk, OperationOutputQuery, StoredChunk,
    read, verify_rows,
};

const CHUNK_BYTES: usize = 32 * 1024;

#[test]
fn child_event_projection_requires_public_exact_well_formed_chunk() {
    let bytes = b"child output";
    let result_sha256 = sha256(bytes);
    let result_id = result_id_for(bytes);
    let event = json!({
        "kind":"operation.output.chunk",
        "visibility":"public",
        "payload":{
            "requestId":"request-child",
            "resultId":result_id,
            "resultSha256":result_sha256,
            "chunkIndex":0,
            "chunkCount":1,
            "byteStart":0,
            "byteEnd":bytes.len(),
            "byteLength":bytes.len(),
            "contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),
            "contentSha256":sha256(bytes),
            "privateExtra":"dropped",
        }
    });
    let chunk =
        OperationOutputChunk::from_public_event(&event, "request-child", &result_id).unwrap();
    assert_eq!(chunk.request_id, "request-child");
    assert_eq!(chunk.content_sha256, sha256(bytes));
    let verified = verify_rows(
        std::iter::once(Ok(StoredChunk::from(chunk))),
        &result_id,
        0,
        OUTPUT_PAGE_BYTES,
    )
    .unwrap();
    let AppOutputRead::Complete(page) = verified else {
        panic!("valid single-chunk result should be complete");
    };
    assert_eq!(page.content.as_slice(), bytes);
    assert_eq!(page.byte_length, bytes.len() as u64);

    let mut private = event.clone();
    private["visibility"] = "internal".into();
    assert!(
        OperationOutputChunk::from_public_event(&private, "request-child", &result_id).is_none()
    );
    assert!(OperationOutputChunk::from_public_event(&event, "other-request", &result_id).is_none());
    let mut malformed = event;
    malformed["payload"]["contentSha256"] = "b".repeat(64).into();
    assert!(
        OperationOutputChunk::from_public_event(&malformed, "request-child", &result_id).is_none()
    );
}

#[test]
fn reads_only_scoped_complete_output_in_utf8_safe_pages() {
    let turn_id = "turn-output";
    let request_id = "request-output";
    let output = format!("{}🙂tail", "a".repeat(OUTPUT_PAGE_BYTES - 2));
    let result_id = result_id_for(output.as_bytes());
    let connection = output_database();

    insert_output_rows(&connection, turn_id, request_id, output.as_bytes());
    let first = read(
        &connection,
        OperationOutputQuery {
            turn_id: turn_id.into(),
            request_id: request_id.into(),
            result_id: result_id.clone(),
            byte_start: 0,
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(first.content, "a".repeat(OUTPUT_PAGE_BYTES - 2));
    assert!(first.content.len() <= OUTPUT_PAGE_BYTES);
    assert_eq!(first.byte_end, (OUTPUT_PAGE_BYTES - 2) as u64);
    assert!(!first.complete);

    let second = read(
        &connection,
        OperationOutputQuery {
            turn_id: turn_id.into(),
            request_id: request_id.into(),
            result_id: result_id.clone(),
            byte_start: first.byte_end,
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(second.content, "🙂tail");
    assert!(second.complete);
    assert_eq!(second.byte_length, output.len() as u64);

    let replacement = vec![b'b'; output.len() - CHUNK_BYTES];
    connection
        .execute(
            "UPDATE app_operation_output_chunks SET content_base64=?1,content_sha256=?2 WHERE turn_id=?3 AND request_id=?4 AND result_id=?5 AND chunk_index=1",
            rusqlite::params![
                base64::engine::general_purpose::STANDARD.encode(&replacement),
                sha256(&replacement),
                turn_id,
                request_id,
                result_id,
            ],
        )
        .unwrap();
    assert!(
        read(
            &connection,
            OperationOutputQuery {
                turn_id: turn_id.into(),
                request_id: request_id.into(),
                result_id: result_id.clone(),
                byte_start: 0,
            },
        )
        .unwrap()
        .is_none(),
        "a corrupt chunk outside the requested page must invalidate the output"
    );

    for (turn_id, request_id, wrong_result_id) in [
        ("other-turn", request_id, result_id.as_str()),
        (turn_id, "other-request", result_id.as_str()),
        (turn_id, request_id, "other-result"),
    ] {
        assert!(
            read(
                &connection,
                OperationOutputQuery {
                    turn_id: turn_id.into(),
                    request_id: request_id.into(),
                    result_id: wrong_result_id.into(),
                    byte_start: 0,
                },
            )
            .unwrap()
            .is_none()
        );
    }
}

#[test]
fn permits_aliased_request_only_when_progress_links_the_result() {
    let turn_id = "turn-alias";
    let stored_request_id = "stored-request";
    let linked_request_id = "linked-request";
    let output = b"child operation output";
    let result_id = result_id_for(output);
    let connection = output_database();
    insert_output_rows(&connection, turn_id, stored_request_id, output);
    connection
        .execute(
            "INSERT INTO turns(id,state,safe_status_label,updated_at) VALUES(?1,'accepted','Accepted','now')",
            [turn_id],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO events(id,type,turn_id,payload_json) VALUES(1,'progress.summary',?1,?2)",
            rusqlite::params![
                turn_id,
                json!({"row":{
                    "kind":"used_tool",
                    "bridge_phase":"btcc_operation",
                    "tool_call_id":linked_request_id,
                    "tool_result_id":result_id,
                }})
                .to_string(),
            ],
        )
        .unwrap();

    let output_view = read(
        &connection,
        OperationOutputQuery {
            turn_id: turn_id.into(),
            request_id: linked_request_id.into(),
            result_id: result_id.clone(),
            byte_start: 0,
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(output_view.content.as_bytes(), output);

    assert!(
        read(
            &connection,
            OperationOutputQuery {
                turn_id: turn_id.into(),
                request_id: "unlinked-request".into(),
                result_id,
                byte_start: 0,
            },
        )
        .unwrap()
        .is_none()
    );
}

fn output_database() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE app_operation_output_chunks(
                turn_id TEXT NOT NULL,request_id TEXT NOT NULL,result_id TEXT NOT NULL,
                result_sha256 TEXT NOT NULL,chunk_index INTEGER NOT NULL,chunk_count INTEGER NOT NULL,
                byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,byte_length INTEGER NOT NULL,
                content_base64 TEXT NOT NULL,content_sha256 TEXT NOT NULL,created_at TEXT NOT NULL
             );
             CREATE TABLE turns(id TEXT PRIMARY KEY,state TEXT NOT NULL,safe_status_label TEXT NOT NULL,safe_error_code TEXT,updated_at TEXT NOT NULL);
             CREATE TABLE app_terminal_turn_projections(turn_id TEXT PRIMARY KEY,progress_rows_json TEXT NOT NULL,source_event_high_water INTEGER NOT NULL,delivery_metadata_json TEXT);
             CREATE TABLE app_terminal_turn_progress_rows(turn_id TEXT NOT NULL,source_event_id INTEGER NOT NULL,row_json TEXT NOT NULL);
             CREATE TABLE app_internal_continuation_progress_events(turn_id TEXT NOT NULL,event_id TEXT NOT NULL);
             CREATE TABLE events(id INTEGER PRIMARY KEY,type TEXT NOT NULL,turn_id TEXT NOT NULL,payload_json TEXT NOT NULL);",
        )
        .unwrap();
    connection
}

fn result_id_for(bytes: &[u8]) -> String {
    let result_sha256 = sha256(bytes);
    sha256(format!("btcc-guided-tool-result.v1\0{result_sha256}").as_bytes())
}

fn insert_output_rows(connection: &Connection, turn_id: &str, request_id: &str, bytes: &[u8]) {
    let result_sha256 = sha256(bytes);
    let result_id = sha256(format!("btcc-guided-tool-result.v1\0{result_sha256}").as_bytes());
    let chunks = bytes.len().div_ceil(CHUNK_BYTES).max(1);
    for chunk_index in 0..chunks {
        let byte_start = chunk_index * CHUNK_BYTES;
        let byte_end = bytes.len().min(byte_start + CHUNK_BYTES);
        let chunk = &bytes[byte_start..byte_end];
        connection
            .execute(
                "INSERT INTO app_operation_output_chunks(
                    turn_id,request_id,result_id,result_sha256,chunk_index,chunk_count,
                    byte_start,byte_end,byte_length,content_base64,content_sha256,created_at
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                rusqlite::params![
                    turn_id,
                    request_id,
                    result_id,
                    result_sha256,
                    chunk_index,
                    chunks,
                    byte_start,
                    byte_end,
                    bytes.len(),
                    base64::engine::general_purpose::STANDARD.encode(chunk),
                    sha256(chunk),
                    format!("created-{chunk_index}"),
                ],
            )
            .unwrap();
    }
}
