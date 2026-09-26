//! App-owned admission facts from the single SQLite lane.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    AppChatSnapshot, AppMessageFileSnapshot, GatewayApplicationError, MaterializedResponderFile,
    PreparedAppAdmission,
    admission_identity::{input_digest, stringify},
    storage::AppStorageError,
};
use crate::{
    gateway::{MessageContentPart, MessageSendRequest},
    public_text::trim_js_whitespace,
};

pub(super) struct Inspected {
    pub chat: AppChatSnapshot,
    pub files: Vec<AppMessageFileSnapshot>,
    pub prepared: PreparedAppAdmission,
    pub replay: Option<Replay>,
}

pub(super) struct Replay {
    digest: String,
    pub controls_json: Option<String>,
    attachments_json: String,
}

pub(super) fn inspect(
    db: &Connection,
    chat_id: &str,
    client_id: &str,
    request: &MessageSendRequest,
) -> Result<Inspected, AppStorageError> {
    inspect_with_attachment_source(db, chat_id, client_id, request, None)
}

pub(super) fn inspect_with_attachment_source(
    db: &Connection,
    chat_id: &str,
    client_id: &str,
    request: &MessageSendRequest,
    reused_from_message_id: Option<&str>,
) -> Result<Inspected, AppStorageError> {
    let chat = chat(db, chat_id)?;
    let relocating = db
        .query_row(
            "SELECT 1 FROM app_session_context_gate WHERE session_id=?1 AND owner_kind='relocate'",
            [chat_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .is_some();
    if relocating {
        return Err(AppStorageError::new(
            "session_relocating",
            "Session context is relocating.",
        ));
    }
    let text = message_text(request);
    let replay = db
        .query_row(
            "SELECT input_identity_digest,control_resolution_json,attachments_json \
             FROM session_queued_messages WHERE chat_id=?1 AND client_message_id=?2",
            params![chat_id, client_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let requested = requested_ids(request);
    let (files, replay) = match replay {
        Some((digest, controls_json, attachments_json)) => {
            // A replay may refer to already-consumed files. Do not apply the
            // one-shot attachability guard to immutable row identity.
            let mut files = Vec::new();
            for id in &requested {
                if let Some(file) = file(db, id)? {
                    files.push(file);
                }
            }
            let digest = digest.ok_or_else(|| {
                AppStorageError::new(
                    "queued_message_identity_conflict",
                    "This client message id was already accepted with different input.",
                )
            })?;
            (
                files,
                Some(Replay {
                    digest,
                    controls_json,
                    attachments_json,
                }),
            )
        }
        None => {
            let mut ids = HashSet::new();
            let unique: Vec<_> = requested
                .iter()
                .filter(|id| !id.is_empty() && ids.insert(*id))
                .collect();
            if unique.len() > 12 {
                return Err(AppStorageError::new(
                    "too_many_attachments",
                    "Too many attachments.",
                ));
            }
            let mut files = Vec::new();
            for id in unique {
                let file = file(db, id)?.ok_or_else(|| {
                    AppStorageError::new("message_file_not_found", "Attachment file not found.")
                })?;
                if let Some(source_message_id) = reused_from_message_id {
                    if !is_user_attachment_for_message(db, &file.id, source_message_id, chat_id)? {
                        return Err(AppStorageError::new(
                            "message_file_already_attached",
                            "Attachment file was not attached to the retried message.",
                        ));
                    }
                } else if file.message_id.as_deref().is_some_and(|id| !id.is_empty()) {
                    return Err(AppStorageError::new(
                        "message_file_already_attached",
                        "Attachment file was already sent.",
                    ));
                }
                if file
                    .owner_session_id
                    .as_deref()
                    .is_some_and(|owner| !owner.is_empty() && owner != chat_id)
                {
                    return Err(AppStorageError::new(
                        "message_file_wrong_session",
                        "Attachment file belongs to a different session.",
                    ));
                }
                files.push(file);
            }
            if text.is_empty() && files.is_empty() {
                return Err(AppStorageError::new(
                    "empty_queued_message",
                    "Queued message text is required.",
                ));
            }
            (files, None)
        }
    };
    let attachments = Value::Array(
        files
            .iter()
            .map(|file| Value::String(file.id.clone()))
            .collect(),
    );
    let admission_identity = Value::Array(files.iter().map(|file| json!({
        "id":file.id,"kind":file.kind,"mime_type":file.mime_type,"safe_name":file.safe_name,
        "size_bytes":file.size_bytes,"sha256":file.sha256,
    })).collect());
    Ok(Inspected {
        chat,
        files,
        prepared: PreparedAppAdmission {
            text,
            attachments,
            admission_identity,
            project_sources: Value::Array(Vec::new()),
        },
        replay,
    })
}

fn is_user_attachment_for_message(
    db: &Connection,
    file_id: &str,
    message_id: &str,
    chat_id: &str,
) -> Result<bool, AppStorageError> {
    db.query_row(
        "SELECT 1 FROM message_attachments a JOIN messages m ON m.id=a.message_id \
         WHERE a.file_id=?1 AND m.id=?2 AND m.chat_id=?3 AND m.role='user'",
        params![file_id, message_id, chat_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(AppStorageError::sqlite)
}

impl Replay {
    pub(super) fn matches(
        &self,
        request: &MessageSendRequest,
        prepared: &PreparedAppAdmission,
    ) -> Result<bool, GatewayApplicationError> {
        if self.digest == input_digest(request, prepared)? {
            return Ok(true);
        }
        if request.content_parts.is_some() || self.digest != legacy_digest(request, prepared)? {
            return Ok(false);
        }
        let stored = serde_json::from_str::<Value>(&self.attachments_json)
            .ok()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default();
        let stored: Vec<_> = stored
            .iter()
            .map(|item| {
                item.as_str()
                    .or_else(|| item.get("file_id").and_then(Value::as_str))
                    .unwrap_or("")
            })
            .collect();
        Ok(requested_ids(request).iter().map(String::as_str).eq(stored))
    }
}

pub(super) fn file(
    db: &Connection,
    id: &str,
) -> Result<Option<AppMessageFileSnapshot>, AppStorageError> {
    db.query_row(
        "SELECT id,owner_session_id,message_id,kind,mime_type,safe_name,size_bytes,sha256,storage_name,created_at \
         FROM message_files WHERE id=?1",
        [id],
        |row| Ok(AppMessageFileSnapshot {
            id:row.get(0)?,owner_session_id:row.get(1)?,message_id:row.get(2)?,kind:row.get(3)?,
            mime_type:row.get(4)?,safe_name:row.get(5)?,size_bytes:row.get(6)?,sha256:row.get(7)?,
            storage_name:row.get(8)?,created_at:row.get(9)?,
        }),
    ).optional().map_err(AppStorageError::sqlite)
}

pub(super) fn insert_source_files(
    db: &Connection,
    chat_id: &str,
    files: &[MaterializedResponderFile],
) -> Result<(), AppStorageError> {
    for file in files {
        db.execute(
            "INSERT INTO message_files(id,owner_session_id,message_id,kind,mime_type,safe_name,\
             size_bytes,sha256,storage_name,created_at) VALUES(?1,?2,NULL,?3,?4,?5,?6,?7,?8,?9)",
            params![
                file.id,
                chat_id,
                file.kind,
                file.mime_type,
                file.safe_name,
                file.size_bytes,
                file.sha256,
                file.storage_name,
                file.created_at
            ],
        )
        .map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}

fn chat(db: &Connection, id: &str) -> Result<AppChatSnapshot, AppStorageError> {
    db.query_row(
        "SELECT id,project_id,archived FROM chats WHERE id=?1",
        [id],
        |row| {
            Ok(AppChatSnapshot {
                id: row.get(0)?,
                project_id: row.get(1)?,
                archived: row.get::<_, i64>(2)? != 0,
            })
        },
    )
    .optional()
    .map_err(AppStorageError::sqlite)?
    .ok_or_else(|| AppStorageError::new("session_not_found", "Session not found."))
}

fn requested_ids(request: &MessageSendRequest) -> Vec<String> {
    request
        .attachments
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| {
            item.get("file_id")
                .and_then(Value::as_str)
                .map_or("", trim_js_whitespace)
                .to_owned()
        })
        .collect()
}

fn message_text(request: &MessageSendRequest) -> String {
    if let Some(content) = &request.content_parts {
        let mut text = String::new();
        for part in &content.parts {
            match part {
                MessageContentPart::Text { text: value, .. } => text.push_str(value),
                MessageContentPart::SessionRef { title_snapshot, .. }
                | MessageContentPart::ProjectSourceRef { title_snapshot, .. } => {
                    text.push('@');
                    text.push_str(title_snapshot);
                }
            }
        }
        text
    } else {
        request
            .text
            .as_ref()
            .and_then(Value::as_str)
            .map_or("", trim_js_whitespace)
            .into()
    }
}

fn legacy_digest(
    request: &MessageSendRequest,
    prepared: &PreparedAppAdmission,
) -> Result<String, GatewayApplicationError> {
    let value = json!({
        "version":1,"text":prepared.text,
        "explicit_controls":{"model":request.model,"reasoning_effort":request.reasoning_effort,
            "access_mode":request.access_mode,"plan_mode":request.plan_mode},
        "admission_identity":prepared.admission_identity,
    });
    Ok(format!(
        "{:x}",
        Sha256::digest(stringify(&value)?.as_bytes())
    ))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;

    #[test]
    fn retry_attachment_reuse_requires_the_exact_user_message_in_the_same_chat() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE chats(id TEXT PRIMARY KEY,project_id TEXT,archived INTEGER);
             CREATE TABLE app_session_context_gate(session_id TEXT,owner_kind TEXT);
             CREATE TABLE session_queued_messages(
                 chat_id TEXT,client_message_id TEXT,input_identity_digest TEXT,
                 control_resolution_json TEXT,attachments_json TEXT
             );
             CREATE TABLE messages(id TEXT PRIMARY KEY,chat_id TEXT,role TEXT);
             CREATE TABLE message_files(
                 id TEXT PRIMARY KEY,owner_session_id TEXT,message_id TEXT,kind TEXT,
                 mime_type TEXT,safe_name TEXT,size_bytes INTEGER,sha256 TEXT,
                 storage_name TEXT,created_at TEXT
             );
             CREATE TABLE message_attachments(message_id TEXT,file_id TEXT,position INTEGER);
             INSERT INTO chats VALUES('general',NULL,0),('other',NULL,0);
             INSERT INTO messages VALUES
                 ('source-user','general','user'),
                 ('other-user','general','user'),
                 ('foreign-user','other','user');
             INSERT INTO message_files VALUES
                 ('source-file','general','source-user','generic','text/plain','source.txt',4,'hash-a','source','now'),
                 ('foreign-file','general','foreign-user','generic','text/plain','foreign.txt',4,'hash-b','foreign','now');
             INSERT INTO message_attachments VALUES
                 ('source-user','source-file',0),
                 ('foreign-user','foreign-file',0);",
        )
        .unwrap();

        let default_error = inspect(&db, "general", "new-default", &request("source-file"))
            .err()
            .unwrap();
        assert_eq!(default_error.code(), "message_file_already_attached");

        let accepted = inspect_with_attachment_source(
            &db,
            "general",
            "new-retry",
            &request("source-file"),
            Some("source-user"),
        )
        .unwrap();
        assert_eq!(accepted.files[0].id, "source-file");

        let wrong_message = inspect_with_attachment_source(
            &db,
            "general",
            "new-unrelated",
            &request("source-file"),
            Some("other-user"),
        )
        .err()
        .unwrap();
        assert_eq!(wrong_message.code(), "message_file_already_attached");

        let wrong_chat = inspect_with_attachment_source(
            &db,
            "general",
            "new-foreign",
            &request("foreign-file"),
            Some("foreign-user"),
        )
        .err()
        .unwrap();
        assert_eq!(wrong_chat.code(), "message_file_already_attached");
    }

    fn request(file_id: &str) -> MessageSendRequest {
        MessageSendRequest {
            expected_project_id: None,
            content_parts: None,
            chat_id: Some(json!("general")),
            text: Some(json!("retry this")),
            client_message_id: None,
            attachments: Some(json!([{"file_id":file_id}])),
            model: None,
            reasoning_effort: None,
            access_mode: None,
            plan_mode: None,
            subsession_result: None,
        }
    }
}
