use rusqlite::{Connection, OptionalExtension};

use super::migrate;

#[test]
fn fresh_schema_has_full_support_and_functional_message_fts() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&mut connection, None).unwrap();
    connection
        .execute(
            "INSERT INTO chats(id,title,kind,created_at,updated_at) VALUES('general','Onboarding','chat','now','now')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) \
             VALUES('m1','general','user','first searchable','sent','now','now')",
            [],
        )
        .unwrap();
    let found: String = connection
        .query_row(
            "SELECT text FROM messages_fts WHERE messages_fts MATCH 'searchable'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(found, "first searchable");
    connection
        .execute(
            "UPDATE messages SET text='second indexed' WHERE id='m1'",
            [],
        )
        .unwrap();
    let old = connection
        .query_row(
            "SELECT text FROM messages_fts WHERE messages_fts MATCH 'searchable'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .unwrap();
    assert!(old.is_none());
    assert!(table_exists(&connection, "app_terminal_turn_projections"));
    assert!(table_exists(&connection, "app_session_context_gate"));
    assert!(table_exists(&connection, "app_session_branches"));
    assert!(table_exists(&connection, "app_space_nodes"));
}

#[test]
fn deployed_events_gain_actual_turn_index_without_rewriting_payloads() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&mut connection, None).unwrap();
    connection
        .execute_batch(
            "DROP INDEX events_turn_id_idx; \
             CREATE INDEX events_type_turn_id_idx ON events( \
               type,json_extract(payload_json,'$.turn_id'),id DESC); \
             INSERT INTO events(type,turn_id,payload_json,created_at) VALUES( \
               'agent.turn_event','actual-turn', \
               '{\"turn_id\":\"old-payload-turn\",\"event\":{\"kind\":\"turn.completed\"}}','now');",
        )
        .unwrap();
    migrate(&mut connection, None).unwrap();
    let index_sql: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='events_turn_id_idx'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(index_sql.contains("ON events(turn_id,id DESC) WHERE turn_id<>''"));
    let actual: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM events WHERE turn_id='actual-turn' AND turn_id<>'' \
             AND type='agent.turn_event'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(actual, 1);
}

#[test]
fn deployed_schema_adds_columns_without_removing_unknown_data() {
    let mut connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE chats(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,\
               project_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,consumer_note TEXT);\
             CREATE TABLE projects(id TEXT PRIMARY KEY,display_name TEXT NOT NULL,status TEXT NOT NULL,\
               workspace_path TEXT NOT NULL,workspace_label TEXT NOT NULL,safe_path_label TEXT NOT NULL,\
               pinned INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,error_summary TEXT,\
               created_at TEXT NOT NULL,updated_at TEXT NOT NULL);\
             CREATE TABLE messages(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,role TEXT NOT NULL,\
               text TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);\
             CREATE TABLE session_queued_messages(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,text TEXT NOT NULL,\
               controls_json TEXT NOT NULL,attachments_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',\
               safe_error_code TEXT,dispatched_message_id TEXT,turn_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);\
             INSERT INTO chats VALUES('general','Onboarding','general',NULL,'now','now','keep-me');\
             INSERT INTO session_queued_messages(id,chat_id,text,controls_json,attachments_json,created_at,updated_at)\
               VALUES('q1','general',' hello ','{\"model\":\"provider/model\"}','[]','now','now');",
        )
        .unwrap();
    migrate(&mut connection, None).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT consumer_note FROM chats WHERE id='general'",
                [],
                |row| { row.get::<_, String>(0) }
            )
            .unwrap(),
        "keep-me"
    );
    assert_eq!(
        connection
            .query_row("SELECT kind FROM chats WHERE id='general'", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "chat"
    );
    let identity = connection
        .query_row(
            "SELECT client_message_id,input_identity_digest,control_resolution_json \
             FROM session_queued_messages WHERE id='q1'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .unwrap();
    assert!(identity.0.starts_with("client-"));
    assert_eq!(identity.1.len(), 64);
    assert!(identity.2.contains("session_override"));
    assert!(column_exists(&connection, "messages", "content_parts_json"));
    assert!(column_exists(
        &connection,
        "session_queued_messages",
        "project_source_refs_json"
    ));
}

fn table_exists(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .unwrap()
        .is_some()
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> bool {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap();
    statement
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .any(|name| name.unwrap() == column)
}
