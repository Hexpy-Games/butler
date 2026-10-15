use rusqlite::{Connection, OptionalExtension, params};

use super::{AppStorageError, contracts::*, read};
use crate::gateway::application::storage::AppStorageCode;
use crate::gateway::application::{AppIdentityClock, EventSubscribers, events};
use butler_core::public_text::trim_js_whitespace;

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
    input: &AppCreateSessionInput,
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
                AppStorageError::new(
                    AppStorageCode::ProjectRequired,
                    "Project session requires a project.",
                )
            })?;
        let present = db
            .query_row("SELECT id FROM projects WHERE id=?1", [id], |_| Ok(()))
            .optional()
            .map_err(AppStorageError::sqlite)?;
        if present.is_none() {
            return Err(AppStorageError::new(
                AppStorageCode::ProjectNotFound,
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
    let group_key = input
        .group_id
        .as_deref()
        .map(|group| group_key(db, group, project_id.as_deref()))
        .transpose()?;
    let id = identity(input, clock);
    let now = clock.now_iso();
    db.execute(
        r"
INSERT INTO chats(id,title,kind,project_id,pinned,archived,created_at,updated_at)
VALUES(?1,?2,?3,?4,0,0,?5,?5)
",
        params![id, title, input.kind.as_str(), project_id, now],
    )
    .map_err(AppStorageError::sqlite)?;
    if let Some(group_key) = group_key {
        // Same placement as the creation trigger, inside the group: first child.
        db.execute(
            "UPDATE app_space_nodes SET parent_key=?1,manual_placement=1,revision=revision+1,
               position=(SELECT COALESCE(MIN(position),1)-1 FROM app_space_nodes WHERE parent_key=?1)
             WHERE node_key=?2",
            params![group_key, format!("s:{id}")],
        )
        .map_err(AppStorageError::sqlite)?;
    }
    let summary = read::session(db, &id)?;
    if emit_created {
        append_created(db, subscribers, &summary, &clock.now_iso())?;
    }
    Ok(summary)
}

/// The node key of a sidebar group a new session may be created in.
fn group_key(
    db: &Connection,
    group_id: &str,
    project_id: Option<&str>,
) -> Result<String, AppStorageError> {
    let key = format!("g:{}", trim_js_whitespace(group_id));
    let scope = db
        .query_row(
            "SELECT g.scope_project_id FROM app_space_nodes n
             JOIN app_space_groups g ON g.id=n.group_id WHERE n.node_key=?1",
            [&key],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .ok_or_else(|| {
            AppStorageError::new(AppStorageCode::SpaceGroupNotFound, "Group not found.")
        })?;
    if scope.as_deref() != project_id {
        return Err(AppStorageError::new(
            AppStorageCode::SpaceProjectBoundary,
            "The group belongs to a different project.",
        ));
    }
    Ok(key)
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
    let payload = butler_core::json::json_object!({"session":summary});
    events::append_unpublished(db, "session.created", None, payload, &clock.now_iso())
}

fn append_created(
    db: &Connection,
    subscribers: &EventSubscribers,
    summary: &AppSessionSummary,
    now: &str,
) -> Result<(), AppStorageError> {
    let payload = butler_core::json::json_object!({"session":summary});
    events::append(db, subscribers, "session.created", None, payload, now)?;
    Ok(())
}

pub(super) fn rollback(db: &Connection, id: &str) -> Result<(), AppStorageError> {
    if id == "general" {
        return Err(AppStorageError::new(
            AppStorageCode::GeneralChannelProtected,
            "일반 채널은 보관하거나 삭제할 수 없습니다.",
        ));
    }
    db.execute("DELETE FROM chats WHERE id=?1", [id])
        .map_err(AppStorageError::sqlite)?;
    Ok(())
}
