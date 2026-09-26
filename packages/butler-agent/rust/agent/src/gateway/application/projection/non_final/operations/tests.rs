use rusqlite::Connection;

use super::*;

#[test]
fn runtime_fault_retryable_is_projected_to_turn_and_state_event() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE messages(
             id TEXT PRIMARY KEY,chat_id TEXT,turn_id TEXT,role TEXT,text TEXT,status TEXT,
             created_at TEXT,updated_at TEXT,safe_error_code TEXT,retryable INTEGER
         );
         CREATE TABLE turns(
             id TEXT PRIMARY KEY,state TEXT,safe_status_label TEXT,safe_error_code TEXT,
             retryable INTEGER,cancellable INTEGER,updated_at TEXT
         );
         CREATE TABLE events(
             id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT,turn_id TEXT,
             payload_json TEXT,created_at TEXT
         );
         INSERT INTO turns VALUES('turn-1','thinking','Thinking',NULL,0,1,'now');",
    )
    .unwrap();
    let subscribers = EventSubscribers::default();
    let metadata: serde_json::Map<String, serde_json::Value> =
        json!({"safeErrorCode":"runtime_fault"})
            .as_object()
            .unwrap()
            .clone();
    let message: serde_json::Map<String, serde_json::Value> = json!({"text":"Runtime interrupted"})
        .as_object()
        .unwrap()
        .clone();

    project_failed(
        &db,
        &subscribers,
        "chat-1",
        "turn-1",
        FailedProjection {
            metadata: &metadata,
            message: &message,
            retryable: true,
        },
        "now",
        &ProjectionIds {
            event_id: "event-1".into(),
            message_id: "message-1".into(),
        },
    )
    .unwrap();

    let turn_retryable: bool = db
        .query_row("SELECT retryable FROM turns WHERE id='turn-1'", [], |row| {
            row.get(0)
        })
        .unwrap();
    let message_retryable: bool = db
        .query_row(
            "SELECT retryable FROM messages WHERE id='message-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let payload_json: String = db
        .query_row(
            "SELECT payload_json FROM events WHERE type='turn.state_changed'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&payload_json).unwrap();

    assert!(turn_retryable);
    assert!(message_retryable);
    assert_eq!(payload["retryable"], true);
}
