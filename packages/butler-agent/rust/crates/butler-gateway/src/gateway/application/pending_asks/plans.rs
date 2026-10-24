//! Exact App projection of the currently actionable draft plan, never Ledger ownership.
use super::*;
use rusqlite::{Connection, OptionalExtension, params};

pub(crate) const SESSION: &str = "SELECT p.chat_id,p.plan_id,p.message_id,p.created_at,m.turn_id,m.plan_json,c.title FROM app_open_plan_decisions p INDEXED BY sqlite_autoindex_app_open_plan_decisions_1 CROSS JOIN messages m INDEXED BY sqlite_autoindex_messages_1 ON m.id=p.message_id CROSS JOIN chats c INDEXED BY sqlite_autoindex_chats_1 ON c.id=p.chat_id WHERE p.chat_id=?1 AND c.archived=0";
pub(crate) const GLOBAL: &str = "SELECT p.chat_id,p.plan_id,p.message_id,p.created_at,m.turn_id,m.plan_json,c.title FROM app_open_plan_decisions p INDEXED BY app_open_plan_decisions_created CROSS JOIN messages m INDEXED BY sqlite_autoindex_messages_1 ON m.id=p.message_id CROSS JOIN chats c INDEXED BY sqlite_autoindex_chats_1 ON c.id=p.chat_id WHERE c.archived=0 ORDER BY p.created_at DESC,p.plan_id DESC LIMIT ?1";
pub(crate) const BEFORE: &str = "SELECT p.chat_id,p.plan_id,p.message_id,p.created_at,m.turn_id,m.plan_json,c.title FROM app_open_plan_decisions p INDEXED BY app_open_plan_decisions_created CROSS JOIN messages m INDEXED BY sqlite_autoindex_messages_1 ON m.id=p.message_id CROSS JOIN chats c INDEXED BY sqlite_autoindex_chats_1 ON c.id=p.chat_id WHERE c.archived=0 AND p.created_at<=?2 AND (p.created_at<?2 OR 'plan:'||p.plan_id<?3) ORDER BY p.created_at DESC,p.plan_id DESC LIMIT ?1";
pub(crate) const FIND: &str = "SELECT plan_id FROM app_open_plan_decisions WHERE chat_id=?1";
pub(crate) const DELETE: &str = "DELETE FROM app_open_plan_decisions WHERE chat_id=?1";
pub(crate) const INSERT: &str = "INSERT INTO app_open_plan_decisions(chat_id,plan_id,message_id,created_at) VALUES(?1,?2,?3,?4)";
pub(crate) const COUNT: &str = "SELECT COUNT(*) FROM app_open_plan_decisions WHERE chat_id=?1";

pub(super) fn read(
    db: &Connection,
    session: Option<&str>,
    limit: usize,
    before: Option<&str>,
) -> Result<Vec<PendingAsk>, AppStorageError> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let cursor = before.and_then(|s| s.split_once('|'));
    let sql = if session.is_some() {
        SESSION
    } else if cursor.is_some() {
        BEFORE
    } else {
        GLOBAL
    };
    let mut statement = db.prepare_cached(sql).map_err(AppStorageError::sqlite)?;
    let values: Vec<rusqlite::types::Value> = if let Some(session) = session {
        vec![session.to_owned().into()]
    } else if let Some((time, id)) = cursor {
        vec![limit.into(), time.to_owned().into(), id.to_owned().into()]
    } else {
        vec![limit.into()]
    };
    let rows = statement
        .query_map(rusqlite::params_from_iter(values), |row| {
            let chat: String = row.get(0)?;
            let plan_id: String = row.get(1)?;
            let plan: String = row.get(5)?;
            let plan: Value = serde_json::from_str(&plan).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    5,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            Ok(PendingAsk {
                ask_id: format!("plan:{plan_id}"),
                kind: "plan_decision".into(),
                session_id: chat.clone(),
                source_session_id: chat,
                source_turn_id: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                source_message_id: row.get(2)?,
                source_call_id: None,
                deferred: false,
                waiting_since: row.get(3)?,
                title: plan
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(&plan_id)
                    .into(),
                summary: None,
                blocking: false,
                state: "open".into(),
                created_at: row.get(3)?,
                actions: vec!["open".into(), "accept".into(), "decline".into()],
                session_title: Some(row.get(6)?),
            })
        })
        .map_err(AppStorageError::sqlite)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}

pub(in crate::gateway::application) fn project(
    db: &Connection,
    subscribers: &super::super::EventSubscribers,
    chat: &str,
    plan: Option<&Value>,
    message: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    close(db, subscribers, chat, "superseded", now)?;
    if let Some(plan) = plan
        && plan.get("status").and_then(Value::as_str) == Some("draft")
        && let Some(id) = plan.get("id").and_then(Value::as_str)
    {
        db.execute(INSERT, params![chat, id, message, now])
            .map_err(AppStorageError::sqlite)?;
        // Authority count is filled by the asynchronous registry event relay.
        events::enqueue_plan(db, subscribers, chat, id, "open")?;
    }
    Ok(())
}
pub(in crate::gateway::application) fn close(
    db: &Connection,
    subscribers: &super::super::EventSubscribers,
    chat: &str,
    state: &str,
    _now: &str,
) -> Result<(), AppStorageError> {
    let previous: Option<String> = db
        .query_row(FIND, [chat], |r| r.get(0))
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if let Some(id) = previous {
        db.execute(DELETE, [chat])
            .map_err(AppStorageError::sqlite)?;
        events::enqueue_plan(db, subscribers, chat, &id, state)?;
    }
    Ok(())
}
