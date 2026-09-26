
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::Connection;

use super::index;

fn temp_root() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!("butler-query-index-{}-{nonce}", std::process::id()))
}

#[test]
fn transcript_rows_project_to_query_and_fts_tables() {
    let root = temp_root();
    fs::create_dir_all(&root).expect("temporary root");
    let transcript = root.join("sessions/session.jsonl");
    let lines = vec![
            serde_json::json!({
                "eventId": "in-1",
                "sessionId": "steward/test",
                "kind": "inbound",
                "timestamp": "2025-01-02T03:04:05.006Z",
                "payload": {"message": {"text": "  hello memory  "}, "role": "steward"}
            })
            .to_string(),
            serde_json::json!({
                "eventId": "out-1",
                "sessionId": "session-1",
                "kind": "outbound",
                "timestamp": "2025-01-02T03:05:06Z",
                "transport": "mock",
                "payload": {"message": {"text": "reply", "timestamp": "1969-12-31T23:59:59Z"}, "eventId": "mock:out-1"}
            })
            .to_string(),
            "not-json".to_owned(),
        ];

    assert_eq!(
        index(&root, &transcript, &lines).expect("index transcript"),
        2
    );
    let database = Connection::open(root.join("cognition/memory/query/messages.sqlite"))
        .expect("query database");
    let first: (String, String, i64, i64, String) = database
            .query_row(
                "SELECT role, text, internal, placeholder, created_at FROM conversation_messages WHERE source_id='transcript:in-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .expect("projected inbound");
    assert_eq!(
        first,
        (
            "user".into(),
            "hello memory".into(),
            1,
            0,
            "2025-01-02T03:04:05.006Z".into()
        )
    );
    let second: (String, i64, String) = database
            .query_row(
                "SELECT role, placeholder, transcript_file FROM conversation_messages WHERE source_id='transcript:out-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("projected outbound");
    assert_eq!(
        second,
        (
            "assistant".into(),
            1,
            transcript.to_string_lossy().into_owned()
        )
    );
    let fts_count: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM conversation_messages_fts WHERE conversation_messages_fts MATCH 'hello'",
                [],
                |row| row.get(0),
            )
            .expect("fts row");
    assert_eq!(fts_count, 1);
    drop(database);
    fs::remove_dir_all(root).expect("remove temporary root");
}
