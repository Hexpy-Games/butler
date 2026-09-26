//! Read-only App projections consumed by scheduled New Chat Briefing.

use std::{collections::HashSet, path::Path};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AppNewChatBriefingProject {
    pub id: String,
    pub display_name: String,
    pub ledger_project_id: Option<String>,
    pub recent_session_titles: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AppNewChatBriefingReadError;

pub(crate) fn read_new_chat_briefing_settings(database_path: &Path) -> Value {
    if !database_path.exists() {
        return Value::Object(Map::new());
    }
    let Ok(database) = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return Value::Object(Map::new());
    };
    let settings = read_settings(&database);
    drop(database);
    settings
}

pub(crate) fn read_new_chat_briefing_projects(
    database_path: &Path,
) -> Result<Option<Vec<AppNewChatBriefingProject>>, AppNewChatBriefingReadError> {
    if !database_path.exists() {
        return Ok(None);
    }
    let database = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| AppNewChatBriefingReadError)?;
    let projects = read_projects(&database)?;
    drop(database);
    Ok(Some(projects))
}

fn read_settings(database: &Connection) -> Value {
    let encoded = database
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = 'settings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    let settings = encoded
        .as_deref()
        .and_then(|encoded| serde_json::from_str::<Value>(encoded).ok());
    let Some(settings) = settings.and_then(|value| value.as_object().cloned()) else {
        return Value::Object(Map::new());
    };
    let mut projected = Map::new();
    for key in [
        "language",
        "model",
        "consolidation_model",
        "reasoning_effort",
        "consolidation_reasoning_effort",
    ] {
        if let Some(value) = settings.get(key) {
            projected.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(projected)
}

fn read_projects(
    database: &Connection,
) -> Result<Vec<AppNewChatBriefingProject>, AppNewChatBriefingReadError> {
    let mut projects = database
        .prepare(
            "SELECT id, display_name, ledger_project_id FROM projects \
             WHERE archived = 0 AND status = 'active' ORDER BY display_name ASC",
        )
        .map_err(|_| AppNewChatBriefingReadError)?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|_| AppNewChatBriefingReadError)?
        .map(|row| row.map_err(|_| AppNewChatBriefingReadError))
        .collect::<Result<Vec<_>, _>>()?;

    let mut titles = database
        .prepare(
            "SELECT title FROM chats WHERE project_id = ?1 AND archived = 0 \
             ORDER BY updated_at DESC LIMIT 8",
        )
        .map_err(|_| AppNewChatBriefingReadError)?;
    let mut output = Vec::with_capacity(projects.len());
    for (id, display_name, ledger_project_id) in projects.drain(..) {
        let recent_session_titles = titles
            .query_map([&id], |row| row.get::<_, String>(0))
            .map_err(|_| AppNewChatBriefingReadError)?
            .map(|row| row.map_err(|_| AppNewChatBriefingReadError))
            .collect::<Result<Vec<_>, _>>()?;
        output.push(AppNewChatBriefingProject {
            id,
            display_name,
            ledger_project_id,
            recent_session_titles: unique_titles(recent_session_titles),
        });
    }
    Ok(output)
}

fn unique_titles(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .take(8)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use rusqlite::Connection;
    use serde_json::json;

    use super::{read_new_chat_briefing_projects, read_new_chat_briefing_settings};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            Self(
                std::env::temp_dir()
                    .join(format!("butler-briefing-app-read-{}", uuid::Uuid::new_v4())),
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
}
