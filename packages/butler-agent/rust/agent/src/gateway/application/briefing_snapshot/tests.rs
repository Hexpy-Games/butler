
use std::{fs, path::PathBuf};

use rusqlite::Connection;
use serde_json::json;

use super::{read_new_chat_briefing_projects, read_new_chat_briefing_settings};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self(
            std::env::temp_dir().join(format!("butler-briefing-app-read-{}", uuid::Uuid::new_v4())),
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn reads_only_active_app_projects_and_briefing_preferences() {
    let fixture = Fixture::new();
    fs::create_dir_all(&fixture.0).unwrap();
    let database_path = fixture.0.join("app.sqlite");
    let database = Connection::open(&database_path).unwrap();
    database
            .execute_batch(
                "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);\
                 CREATE TABLE projects (id TEXT, display_name TEXT, ledger_project_id TEXT, archived INTEGER, status TEXT);\
                 CREATE TABLE chats (id TEXT, project_id TEXT, title TEXT, archived INTEGER, updated_at TEXT);",
            )
            .unwrap();
    database
        .execute(
            "INSERT INTO app_settings VALUES ('settings', ?1)",
            [json!({
                "language":"ko", "model":"openai/gpt-5.6-sol",
                "reasoning_effort":"medium", "private_extra":"omit",
            })
            .to_string()],
        )
        .unwrap();
    database
            .execute_batch(
                "INSERT INTO projects VALUES ('active', 'Alpha', 'ledger-alpha', 0, 'active');\
                 INSERT INTO projects VALUES ('archived', 'Archived', 'ledger-archived', 1, 'active');\
                 INSERT INTO projects VALUES ('inactive', 'Inactive', 'ledger-inactive', 0, 'completed');\
                 INSERT INTO chats VALUES ('chat-1', 'active', '  Recent topic  ', 0, '2026-09-25T03:00:00Z');\
                 INSERT INTO chats VALUES ('chat-2', 'active', 'Older topic', 0, '2026-09-24T03:00:00Z');\
                 INSERT INTO chats VALUES ('chat-3', 'active', 'Archived title', 1, '2026-09-26T03:00:00Z');",
            )
            .unwrap();
    drop(database);

    let settings = read_new_chat_briefing_settings(&database_path);
    let projects = read_new_chat_briefing_projects(&database_path)
        .unwrap()
        .unwrap();
    assert_eq!(
        settings,
        json!({
            "language":"ko", "model":"openai/gpt-5.6-sol", "reasoning_effort":"medium",
        })
    );
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].id, "active");
    assert_eq!(
        projects[0].ledger_project_id.as_deref(),
        Some("ledger-alpha")
    );
    assert_eq!(
        projects[0].recent_session_titles,
        vec!["Recent topic", "Older topic"]
    );
}

#[test]
fn absent_database_is_not_created_for_ledger_fallback() {
    let fixture = Fixture::new();
    let database_path = fixture.0.join("app.sqlite");
    assert_eq!(read_new_chat_briefing_settings(&database_path), json!({}));
    assert_eq!(
        read_new_chat_briefing_projects(&database_path).unwrap(),
        None
    );
    assert!(!database_path.exists());
}
