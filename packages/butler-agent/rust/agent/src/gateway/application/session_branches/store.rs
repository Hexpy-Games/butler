use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::{AppSessionBranchDestination, AppSessionBranchRequest, AppSessionBranchSeed};
use crate::gateway::application::AppStorageError;

#[derive(Clone)]
pub(super) struct BranchRow {
    pub input_digest: String,
    pub target_session_id: String,
    pub seed_json: String,
    pub source_json: String,
    pub state: String,
}

#[derive(Clone)]
pub(super) struct BranchSourceMessage {
    pub rowid: i64,
    pub id: String,
    pub chat_id: String,
    pub conversation_session_id: Option<String>,
    pub conversation_message_id: Option<String>,
    pub role: String,
    pub status: String,
}

pub(super) fn row(db: &Connection, id: &str) -> Result<Option<BranchRow>, AppStorageError> {
    db.query_row(
        "SELECT input_digest,target_session_id,seed_json,source_json,state \
         FROM app_session_branches WHERE request_id=?1",
        [id],
        |row| {
            Ok(BranchRow {
                input_digest: row.get(0)?,
                target_session_id: row.get(1)?,
                seed_json: row.get(2)?,
                source_json: row.get(3)?,
                state: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}

pub(super) fn saved_request(row: &BranchRow) -> Result<AppSessionBranchRequest, AppStorageError> {
    serde_json::from_str(&row.source_json)
        .map_err(|error| AppStorageError::new("branch_json_invalid", error.to_string()))
}

pub(super) fn insert(
    db: &Connection,
    request: &AppSessionBranchRequest,
    digest: &str,
    target_session_id: &str,
    seed: &AppSessionBranchSeed,
) -> Result<(), AppStorageError> {
    let source_json = serde_json::to_string(request)
        .map_err(|error| AppStorageError::new("branch_json_invalid", error.to_string()))?;
    let seed_json = serde_json::to_string(seed)
        .map_err(|error| AppStorageError::new("branch_json_invalid", error.to_string()))?;
    db.execute(
        "INSERT INTO app_session_branches(request_id,input_digest,target_session_id,source_json,seed_json,state) \
         VALUES(?1,?2,?3,?4,?5,'prepared')",
        params![request.request_id, digest, target_session_id, source_json, seed_json],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

pub(super) fn mark_ready(db: &Connection, request_id: &str) -> Result<bool, AppStorageError> {
    db.execute(
        "UPDATE app_session_branches SET state='ready' WHERE request_id=?1 AND state='prepared'",
        [request_id],
    )
    .map(|changed| changed == 1)
    .map_err(AppStorageError::sqlite)
}

pub(super) fn resolve_source_session(
    db: &Connection,
    requested: &str,
    canonical: Option<&(String, String)>,
) -> Result<Option<String>, AppStorageError> {
    let direct: Option<String> = db
        .query_row("SELECT id FROM chats WHERE id=?1", [requested], |row| {
            row.get(0)
        })
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if direct.is_some() {
        return Ok(direct);
    }
    let Some((canonical_session, external_session)) = canonical else {
        return Ok(None);
    };
    if let Some(id) = db
        .query_row(
            "SELECT id FROM chats WHERE conversation_session_id=?1 LIMIT 1",
            [canonical_session],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
    {
        return Ok(Some(id));
    }
    let mut statement = db
        .prepare("SELECT id FROM chats ORDER BY rowid")
        .map_err(AppStorageError::sqlite)?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    Ok(ids
        .into_iter()
        .find(|id| super::super::app_session_hint(id) == *external_session))
}

pub(super) fn selected_message(
    db: &Connection,
    session_id: &str,
    requested_id: Option<&str>,
) -> Result<Option<BranchSourceMessage>, AppStorageError> {
    let row = db
        .query_row(
            "SELECT rowid,id,chat_id,conversation_session_id,conversation_message_id,role,status \
             FROM messages WHERE chat_id=?1 AND role='assistant' \
             AND status IN ('delivered','completed','sent') AND (?2 IS NULL OR id=?2 OR conversation_message_id=?2) \
             ORDER BY rowid DESC LIMIT 1",
            params![session_id, requested_id],
            message_row,
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    Ok(row)
}

pub(super) fn message_by_id(
    db: &Connection,
    session_id: &str,
    id: &str,
) -> Result<Option<BranchSourceMessage>, AppStorageError> {
    selected_message(db, session_id, Some(id))
}

pub(super) fn unique_message_for_turn(
    db: &Connection,
    session_id: &str,
    turn_id: &str,
) -> Result<Option<BranchSourceMessage>, AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT rowid,id,chat_id,conversation_session_id,conversation_message_id,role,status \
             FROM messages WHERE chat_id=?1 AND turn_id=?2 \
             AND role='assistant' AND status IN ('delivered','completed','sent') \
             AND NOT(role='assistant' AND safe_error_code IS NOT NULL \
                 AND safe_error_code IN ('app_turn_queue_failed','goal_completion_incomplete')) LIMIT 2",
        )
        .map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map(params![session_id, turn_id], message_row)
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    Ok((rows.len() == 1).then(|| rows[0].clone()))
}

pub(super) fn app_context(
    db: &Connection,
    message: &BranchSourceMessage,
) -> Result<String, AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT role,text FROM messages WHERE chat_id=?1 AND rowid<=?2 \
             AND role IN ('user','assistant') AND NOT(role='assistant' AND safe_error_code IS NOT NULL \
                 AND safe_error_code IN ('app_turn_queue_failed','goal_completion_incomplete')) \
             ORDER BY rowid DESC LIMIT 100",
        )
        .map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map(params![message.chat_id, message.rowid], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let mut text = String::from(
        "Recent public conversation window ending at the selected answer; older details may be omitted.",
    );
    for (role, message) in rows.into_iter().rev() {
        text.push_str("\n\n");
        text.push_str(&role);
        text.push_str(": ");
        text.push_str(&message);
    }
    Ok(text)
}

pub(super) fn input_digest(request: &AppSessionBranchRequest) -> Result<String, AppStorageError> {
    let (kind, destination) = match &request.destination {
        AppSessionBranchDestination::Chat => ("chat", Value::Null),
        AppSessionBranchDestination::Project { project_id } => {
            ("project", Value::String(project_id.clone()))
        }
        AppSessionBranchDestination::NewProject { name } => {
            ("new_project", Value::String(name.clone()))
        }
    };
    let digest_input = json!([
        request.source_session_id,
        request.source_message_id,
        request.title,
        kind,
        destination,
        request
            .follow_up
            .as_deref()
            .map(|value| Value::String(value.to_owned()))
            .unwrap_or(Value::Null),
    ]);
    let encoded = serde_json::to_string(&digest_input)
        .map_err(|error| AppStorageError::new("branch_json_invalid", error.to_string()))?;
    use sha2::{Digest, Sha256};
    let mut digest = String::with_capacity(64);
    for byte in Sha256::digest(encoded.as_bytes()) {
        use std::fmt::Write as _;
        // Writing to a String cannot fail.
        let _ = write!(&mut digest, "{byte:02x}");
    }
    Ok(digest)
}

pub(super) fn seed(row: &BranchRow) -> Result<AppSessionBranchSeed, AppStorageError> {
    serde_json::from_str(&row.seed_json)
        .map_err(|error| AppStorageError::new("branch_json_invalid", error.to_string()))
}

fn message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BranchSourceMessage> {
    Ok(BranchSourceMessage {
        rowid: row.get(0)?,
        id: row.get(1)?,
        chat_id: row.get(2)?,
        conversation_session_id: row.get(3)?,
        conversation_message_id: row.get(4)?,
        role: row.get(5)?,
        status: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_branch_digest_matches_source_array_projection() {
        let request = AppSessionBranchRequest {
            request_id: "not-part-of-source-digest".into(),
            source_session_id: "session-id".into(),
            source_message_id: "message-id".into(),
            title: "Topic".into(),
            follow_up: None,
            destination: AppSessionBranchDestination::Chat,
        };

        assert_eq!(
            input_digest(&request).unwrap(),
            "d535ef64869461b7a5023af1bbaa9c5da03ccedf38c3901ca9f3fb4fb709669b"
        );

        let mut changed = request;
        changed.follow_up = Some("continue".into());
        assert_ne!(
            input_digest(&changed).unwrap(),
            "d535ef64869461b7a5023af1bbaa9c5da03ccedf38c3901ca9f3fb4fb709669b"
        );
    }
}
