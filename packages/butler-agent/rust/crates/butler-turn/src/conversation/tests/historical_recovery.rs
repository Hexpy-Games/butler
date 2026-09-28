use std::fs;

use rusqlite::Connection;

use super::test_path;
use crate::conversation::historical_recovery::read_historical_app_rows;

#[test]
fn app_projection_reader_handles_optional_canonical_columns() {
    let path = test_path("historical-app");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(
        "CREATE TABLE messages(id TEXT,chat_id TEXT,role TEXT,text TEXT,created_at TEXT);\
         INSERT INTO messages VALUES('legacy-1','general','user','hello','2026-07-02T00:00:00.000Z');",
    ).unwrap();
    drop(connection);
    let legacy = read_historical_app_rows(&path).unwrap();
    assert_eq!(legacy.len(), 1);
    assert_eq!(legacy[0].id, "legacy-1");
    assert_eq!(legacy[0].conversation_session_id, None);
    let _ = fs::remove_file(&path);

    let canonical_path = test_path("historical-app-canonical");
    let connection = Connection::open(&canonical_path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE messages(id TEXT,chat_id TEXT,role TEXT,text TEXT,created_at TEXT,\
         conversation_session_id TEXT,conversation_turn_id TEXT,conversation_message_id TEXT);\
         INSERT INTO messages VALUES('canonical-1','chat-1','assistant','answer',\
         '2026-07-02T00:00:00.000Z','cs-1','ct-1','cm-1');",
        )
        .unwrap();
    drop(connection);
    let canonical = read_historical_app_rows(&canonical_path).unwrap();
    assert_eq!(
        canonical[0].conversation_session_id.as_deref(),
        Some("cs-1")
    );
    assert_eq!(canonical[0].conversation_turn_id.as_deref(), Some("ct-1"));
    assert_eq!(
        canonical[0].conversation_message_id.as_deref(),
        Some("cm-1")
    );
    let _ = fs::remove_file(canonical_path);
}
