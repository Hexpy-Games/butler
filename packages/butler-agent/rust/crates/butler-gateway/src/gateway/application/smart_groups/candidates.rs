//! Indexed eligibility and candidate reads; never a full table scan.
use rusqlite::{Connection, OptionalExtension};

use super::super::storage::AppStorageError;

/// Top-level sidebar items read through `app_space_children`.
const CANDIDATE_WINDOW: i64 = 24;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CandidateKind {
    Group,
    Conversation,
}

#[derive(Clone, Debug)]
pub(super) struct Candidate {
    pub key: String,
    pub kind: CandidateKind,
    pub title: String,
    pub topic: Option<String>,
}

pub(super) struct Prepared {
    pub message_id: String,
    pub text: String,
    pub node_revision: i64,
    pub usage_session: String,
    pub candidates: Vec<Candidate>,
}

/// The conversation's only user message and its automatic top-level node.
pub(super) struct Source {
    pub message_id: String,
    pub text: String,
    pub node_revision: i64,
    /// The message an already stored topic came from.
    pub topic_message_id: Option<String>,
}

pub(super) fn prepare(db: &Connection, chat: &str) -> Result<Option<Prepared>, AppStorageError> {
    if !enabled(db)? {
        return Ok(None);
    }
    let Some(source) = eligible(db, chat)? else {
        return Ok(None);
    };
    if source.topic_message_id.is_some()
        || butler_core::public_text::trim_js_whitespace(&source.text).is_empty()
    {
        return Ok(None);
    }
    let usage_session = super::super::monitoring::usage::runtime_session(db, chat)?.0;
    Ok(Some(Prepared {
        message_id: source.message_id,
        text: source.text,
        node_revision: source.node_revision,
        usage_session,
        candidates: candidates(db, chat)?,
    }))
}

pub(super) fn enabled(db: &Connection) -> Result<bool, AppStorageError> {
    let enabled: Option<Option<bool>> = db
        .query_row(
            "SELECT json_extract(value_json,'$.smart_grouping_enabled') FROM app_settings WHERE key='settings'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    Ok(enabled.flatten().unwrap_or(true))
}

pub(super) fn eligible(db: &Connection, chat: &str) -> Result<Option<Source>, AppStorageError> {
    let node_revision = db
        .query_row(
            "SELECT n.revision FROM chats c JOIN app_space_nodes n ON n.session_id=c.id \
             WHERE c.id=?1 AND c.kind='chat' AND c.project_id IS NULL AND c.archived=0 \
             AND n.parent_key IS NULL AND n.manual_placement=0 \
             AND NOT EXISTS(SELECT 1 FROM app_session_branches WHERE target_session_id=c.id) \
             AND NOT EXISTS(SELECT 1 FROM app_automations WHERE target_session_id=c.id)",
            [chat],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let Some(node_revision) = node_revision else {
        return Ok(None);
    };
    // At most two users are needed to decide first-message eligibility.
    let mut statement = db
        .prepare("SELECT id,text FROM messages WHERE chat_id=?1 AND role='user' LIMIT 2")
        .map_err(AppStorageError::sqlite)?;
    let users = statement
        .query_map([chat], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let [(message_id, text)] = users.as_slice() else {
        return Ok(None);
    };
    let topic_message_id = db
        .query_row(
            "SELECT source_message_id FROM app_space_topics WHERE session_id=?1",
            [chat],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    Ok(Some(Source {
        message_id: message_id.clone(),
        text: text.clone(),
        node_revision,
        topic_message_id,
    }))
}

fn candidates(db: &Connection, chat: &str) -> Result<Vec<Candidate>, AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT n.node_key,n.group_id IS NOT NULL,COALESCE(g.title,c.title,''),t.topic,
                CASE WHEN n.group_id IS NOT NULL THEN g.scope_project_id IS NULL
                     ELSE n.session_id IS NOT NULL AND n.session_id!=?1 AND n.manual_placement=0
                      AND c.kind='chat' AND c.archived=0 AND c.project_id IS NULL END
             FROM (SELECT node_key,session_id,group_id,manual_placement,position
                   FROM app_space_nodes WHERE parent_key IS NULL
                   ORDER BY position,node_key LIMIT ?2) n
             LEFT JOIN chats c ON c.id=n.session_id
             LEFT JOIN app_space_groups g ON g.id=n.group_id
             LEFT JOIN app_space_topics t ON t.session_id=n.session_id
             ORDER BY n.position,n.node_key",
        )
        .map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map(rusqlite::params![chat, CANDIDATE_WINDOW], |row| {
            let kind = if row.get::<_, bool>(1)? {
                CandidateKind::Group
            } else {
                CandidateKind::Conversation
            };
            let candidate = Candidate {
                key: row.get(0)?,
                kind,
                title: row.get(2)?,
                topic: row.get(3)?,
            };
            Ok(row
                .get::<_, Option<bool>>(4)?
                .unwrap_or(false)
                .then_some(candidate))
        })
        .map_err(AppStorageError::sqlite)?;
    rows.filter_map(Result::transpose)
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}
