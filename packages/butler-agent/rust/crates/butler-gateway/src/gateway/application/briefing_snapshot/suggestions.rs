//! Read-only App facts for Butler's nightly suggestions: recent chats, 예약 작업 and 서랍.
use std::path::Path;

use butler_platform::sqlite;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};

use super::AppNewChatBriefingReadError;
use crate::gateway::application::message_visibility::owner_visible;

const CHATS: usize = 50;
const TEXT_CHARS: usize = 600;
const DRAWER_ITEMS: usize = 200;

/// A chat active in the window.
#[derive(Clone, Debug, Default)]
pub struct AppSuggestionChat {
    pub id: String,
    pub title: String,
    pub project: Option<String>,
    pub last_active: String,
    /// The runtime session id the conversation store binds this chat to.
    pub runtime_session_id: String,
    pub first_request: Option<String>,
    pub last_reply: Option<String>,
}

/// App facts for one suggestion run.
#[derive(Clone, Debug, Default)]
pub struct AppSuggestionContext {
    pub chats: Vec<AppSuggestionChat>,
    pub schedules: Vec<Value>,
    pub drawer_groups: Vec<Value>,
    pub drawer_items: Vec<Value>,
}

/// Chats active since `since` (only `with_chats`), every 예약 작업, 서랍 groups and newest items.
/// A missing App database reads as empty.
pub fn read_suggestion_context(
    database_path: &Path,
    since: &str,
    with_chats: bool,
) -> Result<AppSuggestionContext, AppNewChatBriefingReadError> {
    if !database_path.exists() {
        return Ok(AppSuggestionContext::default());
    }
    let db = sqlite::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(AppSuggestionContext {
        chats: if with_chats {
            chats(&db, since)?
        } else {
            Vec::new()
        },
        schedules: rows(
            &db,
            "SELECT title,prompt_body,schedule_type,schedule_json,state,last_run_at FROM app_automations ORDER BY created_at,id",
            |r| {
                let schedule: Option<String> = r.get(3)?;
                Ok(
                    json!({"title":r.get::<_, String>(0)?,"prompt":bounded(&r.get::<_, String>(1)?),
                "schedule":schedule.and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or_else(|| json!({"type":r.get::<_, String>(2).unwrap_or_default()})),
                "state":r.get::<_, String>(4)?,"last_run":r.get::<_, Option<String>>(5)?.map(|s| day(&s))}),
                )
            },
            [],
        )?,
        drawer_groups: rows(
            &db,
            "SELECT kind,name FROM browser_library_group ORDER BY kind,position,id",
            |r| Ok(json!({"kind":r.get::<_, String>(0)?,"name":r.get::<_, String>(1)?})),
            [],
        )?,
        drawer_items: rows(
            &db,
            &format!(
                "SELECT l.kind,l.title,g.name,l.created_at FROM browser_library l LEFT JOIN browser_library_group g ON g.id=l.group_id ORDER BY l.created_at DESC,l.id DESC LIMIT {DRAWER_ITEMS}"
            ),
            |r| {
                Ok(
                    json!({"kind":r.get::<_, String>(0)?,"title":r.get::<_, String>(1)?,"group":r.get::<_, Option<String>>(2)?,"saved":day(&r.get::<_, String>(3)?)}),
                )
            },
            [],
        )?,
    })
}

fn chats(
    db: &Connection,
    since: &str,
) -> Result<Vec<AppSuggestionChat>, AppNewChatBriefingReadError> {
    let mut chats = rows(
        db,
        &format!(
            "SELECT c.id,c.title,p.display_name,c.updated_at,c.runtime_session_hint FROM chats c LEFT JOIN projects p ON p.id=c.project_id WHERE c.archived=0 AND c.kind IN ('chat','project') AND c.updated_at>=?1 ORDER BY c.updated_at DESC,c.id LIMIT {CHATS}"
        ),
        |r| {
            let id: String = r.get(0)?;
            let hint: Option<String> = r.get(4)?;
            Ok(AppSuggestionChat {
                runtime_session_id: hint.filter(|h| !h.is_empty()).unwrap_or_else(|| {
                    crate::gateway::application::snapshot_input::session_hint(&id)
                }),
                id,
                title: r.get(1)?,
                project: r.get(2)?,
                last_active: day(&r.get::<_, String>(3)?),
                first_request: None,
                last_reply: None,
            })
        },
        [since],
    )?;
    for chat in &mut chats {
        chat.first_request = text(
            db,
            concat!(
                "SELECT m.text FROM messages m WHERE m.chat_id=?1 AND m.role='user' AND ",
                owner_visible!(),
                " ORDER BY m.created_at,m.rowid LIMIT 1"
            ),
            &chat.id,
        )?;
        chat.last_reply = text(
            db,
            "SELECT m.text FROM messages m WHERE m.chat_id=?1 AND m.role='assistant' AND m.text<>'' ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1",
            &chat.id,
        )?;
    }
    Ok(chats)
}

fn rows<T>(
    db: &Connection,
    sql: &str,
    map: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    params: impl rusqlite::Params,
) -> Result<Vec<T>, AppNewChatBriefingReadError> {
    let mut statement = db.prepare(sql)?;
    Ok(statement
        .query_map(params, map)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

fn text(
    db: &Connection,
    sql: &str,
    id: &str,
) -> Result<Option<String>, AppNewChatBriefingReadError> {
    Ok(db
        .query_row(sql, [id], |row| row.get(0))
        .optional()?
        .map(|s: String| bounded(&s)))
}

fn bounded(s: &str) -> String {
    s.chars().take(TEXT_CHARS).collect()
}
fn day(s: &str) -> String {
    s.chars().take(10).collect()
}
