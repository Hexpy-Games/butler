use rusqlite::{Connection, OptionalExtension, params};

use super::{AppStorageError, contracts::*, read};
use crate::gateway::application::{AppIdentityClock, EventSubscribers, events};
use crate::public_text::trim_js_whitespace;

pub(super) fn identity(input: &AppCreateSessionInput, clock: &dyn AppIdentityClock) -> String {
    match input
        .session_hint
        .as_deref()
        .map(trim_js_whitespace)
        .filter(|hint| !hint.is_empty())
    {
        Some(hint) => safe_local_session_id(hint),
        None => format!("{}-{}", input.kind.as_str(), clock.new_uuid()),
    }
}

fn safe_local_session_id(value: &str) -> String {
    let mut normalized = String::new();
    let mut separator = false;
    for character in value.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            normalized.push(character);
            separator = false;
        } else if !separator {
            normalized.push('-');
            separator = true;
        }
    }
    if normalized.is_empty() {
        "session".to_owned()
    } else {
        normalized
    }
}

pub(super) fn create(
    db: &Connection,
    subscribers: &EventSubscribers,
    input: AppCreateSessionInput,
    clock: &dyn AppIdentityClock,
    emit_created: bool,
) -> Result<AppSessionSummary, AppStorageError> {
    let project_id = if input.kind == AppChatKind::Project {
        let id = input
            .project_id
            .as_deref()
            .map(trim_js_whitespace)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                AppStorageError::new("project_required", "Project session requires a project.")
            })?;
        let present = db
            .query_row("SELECT id FROM projects WHERE id=?1", [id], |_| Ok(()))
            .optional()
            .map_err(AppStorageError::sqlite)?;
        if present.is_none() {
            return Err(AppStorageError::new(
                "project_not_found",
                "Project not found.",
            ));
        }
        Some(id.to_owned())
    } else {
        None
    };
    let title = input
        .title
        .as_deref()
        .map(trim_js_whitespace)
        .filter(|title| !title.is_empty())
        .unwrap_or(if input.kind == AppChatKind::Project {
            "New project chat"
        } else {
            "New chat"
        });
    let id = identity(&input, clock);
    let now = clock.now_iso();
    db.execute(
        r"
INSERT INTO chats(id,title,kind,project_id,pinned,archived,created_at,updated_at)
VALUES(?1,?2,?3,?4,0,0,?5,?5)
",
        params![id, title, input.kind.as_str(), project_id, now],
    )
    .map_err(AppStorageError::sqlite)?;
    let summary = read::session(db, &id)?;
    if emit_created {
        append_created(db, subscribers, &summary, &clock.now_iso())?;
    }
    Ok(summary)
}

pub(super) fn publish(
    db: &Connection,
    subscribers: &EventSubscribers,
    id: &str,
    clock: &dyn AppIdentityClock,
) -> Result<(), AppStorageError> {
    let summary = read::session(db, id)?;
    append_created(db, subscribers, &summary, &clock.now_iso())
}

pub(super) fn append_created_unpublished(
    db: &Connection,
    id: &str,
    clock: &dyn AppIdentityClock,
) -> Result<crate::gateway::AppEventEnvelope, AppStorageError> {
    let summary = read::session(db, id)?;
    let payload = crate::json::json_object!({"session":summary});
    events::append_unpublished(db, "session.created", None, payload, &clock.now_iso())
}

fn append_created(
    db: &Connection,
    subscribers: &EventSubscribers,
    summary: &AppSessionSummary,
    now: &str,
) -> Result<(), AppStorageError> {
    let payload = crate::json::json_object!({"session":summary});
    events::append(db, subscribers, "session.created", None, payload, now)?;
    Ok(())
}

pub(super) fn rollback(db: &Connection, id: &str) -> Result<(), AppStorageError> {
    if id == "general" {
        return Err(AppStorageError::new(
            "general_channel_protected",
            "일반 채널은 보관하거나 삭제할 수 없습니다.",
        ));
    }
    db.execute("DELETE FROM chats WHERE id=?1", [id])
        .map_err(AppStorageError::sqlite)?;
    Ok(())
}
