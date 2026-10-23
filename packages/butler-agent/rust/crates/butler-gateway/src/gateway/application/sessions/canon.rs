//! Uses the same chat creation writer and events as POST /sessions.
use super::*;
use rusqlite::params;

pub(in crate::gateway::application) fn project(
    db: &Connection,
    subscribers: &EventSubscribers,
    clock: &dyn super::super::AppIdentityClock,
    payload: &serde_json::Value,
    op_id: &str,
) -> Result<(), AppStorageError> {
    let owner = payload["session_id"].as_str().unwrap_or_default();
    let chat = if let Some(chat) = identity::resolve_owner(db, owner)? {
        chat
    } else {
        write::create(
            db,
            subscribers,
            &AppCreateSessionInput {
                kind: AppChatKind::Project,
                title: payload["title"].as_str().map(str::to_owned),
                project_id: payload["project_id"].as_str().map(str::to_owned),
                session_hint: Some(
                    owner
                        .strip_prefix("butler/app-")
                        .unwrap_or(owner)
                        .to_owned(),
                ),
                group_id: None,
            },
            clock,
            true,
        )?
        .id
    };
    db.execute(
        "INSERT INTO app_canon_conversations(session_id,work_id,project_id,op_id)
        VALUES(?1,?2,?3,?4) ON CONFLICT(work_id) DO UPDATE SET
        session_id=excluded.session_id,project_id=excluded.project_id,op_id=excluded.op_id",
        params![
            chat,
            payload["work_id"].as_str(),
            payload["project_id"].as_str(),
            op_id
        ],
    )
    .map_err(AppStorageError::sqlite)?;
    db.execute(
        "UPDATE app_space_state SET revision=revision+1 WHERE singleton=1",
        [],
    )
    .map_err(AppStorageError::sqlite)?;
    let revision: i64 = db
        .query_row(
            "SELECT revision FROM app_space_state WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    super::super::events::append(
        db,
        subscribers,
        "space.changed",
        None,
        butler_core::json::json_object!({"revision":revision}),
        &clock.now_iso(),
    )?;
    Ok(())
}
