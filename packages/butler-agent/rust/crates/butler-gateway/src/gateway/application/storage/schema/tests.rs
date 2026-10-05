use rusqlite::{Connection, OptionalExtension};

use super::migrate;
use crate::gateway::application::settings::{
    access_mode_name, conversation_access_mode, default_access_mode,
};
use butler_turn::btcc::AccessMode;

/// Format pin: the App database schema. A fresh database has full support and
/// a working message FTS, deployed events gain their actual turn index
/// without rewriting payloads, deployed schemas gain columns without losing
/// unknown data, and an unsaved access mode resolves by install age.
// test-category: format-pin
#[test]
fn app_schema_migrations_keep_existing_data() {
    fresh_schema_has_full_support_and_functional_message_fts();
    deployed_events_gain_actual_turn_index_without_rewriting_payloads();
    deployed_schema_adds_columns_without_removing_unknown_data();
    an_existing_install_keeps_full_access_until_it_saves_a_mode();
    a_new_install_asks_first_until_it_saves_a_mode();
    super::plans::hot_queries_use_their_indexes();
}

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
    assert!(table_exists(&connection, "app_wallpaper_assets"));
    assert!(table_exists(&connection, "app_wallpaper_module_status"));
    // A deployed General conversation keeps its messages while the internal seed title is repaired.
    super::seed(&connection, "later").unwrap();
    let title: String = connection
        .query_row("SELECT title FROM chats WHERE id='general'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(title, "General");
    let messages: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE chat_id='general'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(messages, 1);
}

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

/// Persisted-format pin (#236, #237): an App database from before ask-first
/// resolves an unsaved access mode to full access, the default it ran with,
/// in its conversations and in the schedules the migration fills alike. A
/// saved mode is kept, and the recorded default is never rewritten.
fn an_existing_install_keeps_full_access_until_it_saves_a_mode() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&mut connection, None).unwrap();
    // A database from before this release has no recorded default.
    connection
        .execute(
            "DELETE FROM app_settings WHERE key='default-access-mode'",
            [],
        )
        .unwrap();
    schedule(&connection, "explicit");
    schedule(&connection, "unset");
    connection
        .execute_batch(
            "INSERT INTO app_settings VALUES('session-controls-explicit:explicit','true','now');\
             INSERT INTO app_settings VALUES('session-controls:explicit','{\"access_mode\":\"read_only\"}','now');\
             INSERT INTO app_settings VALUES('settings','{\"language\":\"en\"}','now');",
        )
        .unwrap();
    migrate(&mut connection, None).unwrap();
    assert_eq!(
        default_access_mode(&connection).unwrap(),
        AccessMode::FullAccess,
        "existing install: an unrecorded default resolves to full access"
    );
    assert_eq!(
        conversation_access_mode(&connection, "unset").unwrap(),
        AccessMode::FullAccess,
        "existing install: an unsaved conversation keeps full access"
    );
    assert_eq!(
        conversation_access_mode(&connection, "explicit").unwrap(),
        AccessMode::ReadOnly,
        "existing install: a saved conversation mode is kept"
    );
    assert_eq!(
        schedule_access(&connection, "explicit"),
        "read_only",
        "existing install: a schedule fills its conversation's saved mode"
    );
    assert_eq!(
        schedule_access(&connection, "unset"),
        "full_access",
        "existing install: a schedule of an unsaved conversation fills full access"
    );
    for chat in ["explicit", "unset"] {
        let conversation = conversation_access_mode(&connection, chat).unwrap();
        assert_eq!(
            schedule_access(&connection, chat),
            access_mode_name(&conversation),
            "existing install: schedule and conversation agree for {chat}"
        );
    }

    schedule(&connection, "global");
    connection
        .execute(
            "UPDATE app_settings SET value_json='{\"access_mode\":\"ask_first\"}' WHERE key='settings'",
            [],
        )
        .unwrap();
    migrate(&mut connection, None).unwrap();
    assert_eq!(
        schedule_access(&connection, "global"),
        "ask_first",
        "existing install: a saved global mode fills later schedules"
    );
    assert_eq!(
        schedule_access(&connection, "unset"),
        "full_access",
        "existing install: a filled schedule is never rewritten"
    );
    assert_eq!(
        default_access_mode(&connection).unwrap(),
        AccessMode::FullAccess,
        "existing install: the recorded default is never rewritten"
    );
}

/// Persisted-format pin (#236): a new App database resolves an unsaved access
/// mode to ask first, and a later start keeps that.
fn a_new_install_asks_first_until_it_saves_a_mode() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&mut connection, None).unwrap();
    assert_eq!(
        default_access_mode(&connection).unwrap(),
        AccessMode::AskFirst,
        "new install: the default is ask first"
    );
    schedule(&connection, "unset");
    migrate(&mut connection, None).unwrap();
    assert_eq!(
        default_access_mode(&connection).unwrap(),
        AccessMode::AskFirst,
        "new install: a later start keeps ask first"
    );
    assert_eq!(
        schedule_access(&connection, "unset"),
        "ask_first",
        "new install: a schedule of an unsaved conversation fills ask first"
    );
    assert_eq!(
        conversation_access_mode(&connection, "unset").unwrap(),
        AccessMode::AskFirst,
        "new install: an unsaved conversation asks first"
    );
}

/// Stores chat `id` and an hourly schedule into it without an access mode,
/// as a schedule from before #237.
fn schedule(connection: &Connection, id: &str) {
    connection
        .execute_batch(&format!(
            "INSERT INTO chats(id,title,kind,created_at,updated_at) VALUES('{id}','t','chat','now','now');\
             INSERT INTO app_automations(id,title,prompt_body,target_kind,target_session_id,\
               interval_seconds,access_mode,state,last_run_state,created_at,updated_at) \
             VALUES('schedule-{id}','t','p','chat','{id}',3600,NULL,'enabled','never_run','now','now');"
        ))
        .unwrap();
}

fn schedule_access(connection: &Connection, id: &str) -> String {
    connection
        .query_row(
            "SELECT access_mode FROM app_automations WHERE id=?1",
            [format!("schedule-{id}")],
            |row| row.get::<_, String>(0),
        )
        .unwrap()
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
