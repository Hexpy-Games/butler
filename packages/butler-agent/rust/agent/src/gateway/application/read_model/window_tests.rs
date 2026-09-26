use rusqlite::{Connection, params};

#[test]
fn latest_turn_is_not_limited_to_the_first_two_hundred_rows() {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE chats(id TEXT PRIMARY KEY); INSERT INTO chats VALUES('chat');
             CREATE TABLE turns(
               id TEXT PRIMARY KEY,chat_id TEXT,user_message_id TEXT,state TEXT,
               safe_status_label TEXT,safe_error_code TEXT,retryable INTEGER,cancellable INTEGER,
               attempt INTEGER,execution_controls_json TEXT,execution_model_json TEXT,
               created_at TEXT,updated_at TEXT
             );",
        )
        .unwrap();
    for index in 0..205 {
        connection.execute(
            "INSERT INTO turns VALUES(?1,'chat',NULL,'delivered','Delivered',NULL,0,0,1,NULL,NULL,?2,?2)",
            params![format!("turn-{index}"), format!("2026-09-21T00:00:{index:03}Z")],
        ).unwrap();
    }
    let latest = super::latest_turn(&connection, "chat").unwrap().unwrap();
    assert_eq!(latest.id, "turn-204");
    assert_eq!(latest.cursor, 205);
}
