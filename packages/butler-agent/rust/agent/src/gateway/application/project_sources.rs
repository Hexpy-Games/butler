//! Project source scope, App-owned reads, public snapshots, and bounded excerpts.

use indexmap::IndexMap;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::*;
use crate::gateway::{MessageContentPart, NativeProjectSnapshot, ProjectSourceReference};
use crate::json::Utf16Prefix;
use crate::public_text::{sanitize_public_text, trim_js_whitespace};

const MAX_SOURCE_BYTES: usize = 10 * 1024 * 1024;

impl AppApplication {
    pub(super) async fn resolve_project_sources(
        &self,
        chat: &AppChatSnapshot,
        content: Option<&MessageContent>,
    ) -> Result<Value, GatewayApplicationError> {
        let parts: Vec<_> = content
            .into_iter()
            .flat_map(|content| &content.parts)
            .filter_map(|part| match part {
                MessageContentPart::ProjectSourceRef {
                    project_id,
                    source,
                    topic,
                    ..
                } => Some((project_id, source, topic)),
                _ => None,
            })
            .collect();
        if parts.is_empty() {
            return Ok(Value::Array(Vec::new()));
        }
        let project_id = chat
            .project_id
            .as_deref()
            .filter(|_| !chat.archived)
            .ok_or_else(scope_changed)?;
        if parts.iter().any(|(id, _, _)| id.as_str() != project_id) {
            return Err(scope_changed());
        }
        let mut unique = IndexMap::new();
        for (_, source, topic) in &parts {
            unique.insert(format!("{}:{}", source.kind, source.id), (*source, *topic));
        }
        if unique.len() > 8
            || parts.iter().any(|(_, source, _)| {
                unique
                    .get(&format!("{}:{}", source.kind, source.id))
                    .is_some_and(|(last, _)| last.revision != source.revision)
            })
        {
            return Err(public(
                400,
                "invalid_project_sources",
                "At most eight consistent project sources are allowed.",
            ));
        }
        let key = project_id.to_owned();
        let project = self
            .storage
            .execute(move |db| project_row(db, &key))
            .await
            .map_err(app_error)?;
        let mut remaining = 4_000;
        let mut resolved = Vec::with_capacity(unique.len());
        for (_, (source, topic)) in unique {
            let document = match source.kind.as_str() {
                "artifact" | "message" => {
                    let project_id = project.id.clone();
                    let source = source.clone();
                    self.storage
                        .execute(move |db| read_app_source(db, &project_id, &source))
                        .await
                        .map_err(app_error)?
                }
                _ => {
                    self.dependencies
                        .admission
                        .read_ledger_source(AppLedgerSourceRequest {
                            project: project.clone(),
                            source: source.clone(),
                        })
                        .await?
                }
            };
            let body = safe_document(
                document.body,
                &self.butler_data.to_string_lossy(),
                &project.workspace_path,
            );
            if body.len() > MAX_SOURCE_BYTES {
                return Err(public(
                    413,
                    "project_source_too_large",
                    "Project source exceeds the snapshot limit.",
                ));
            }
            let title = Utf16Prefix::new(sanitize_public_text(&document.title, ""), 500)
                .utf8_for_hash()
                .into_owned();
            let excerpt = Utf16Prefix::new(body.as_str(), remaining.min(1_000));
            let excerpt_len = excerpt.len_utf16();
            let excerpt_truncated = excerpt_len < body.encode_utf16().count();
            let excerpt_text = excerpt.utf8_for_hash().into_owned();
            remaining -= excerpt_len;
            let file = self
                .dependencies
                .admission
                .snapshot_source(AppSourceSnapshotRequest {
                    name: format!(
                        "{}.md",
                        if title.is_empty() {
                            "project-source"
                        } else {
                            &title
                        }
                    ),
                    body,
                })
                .await?;
            let file_chat = chat.id.clone();
            let stored_file = file.clone();
            self.storage
                .execute(move |db| admission::insert_source_files(db, &file_chat, &[stored_file]))
                .await
                .map_err(app_error)?;
            let mut current = source.clone();
            current.revision = document.revision;
            let mut value = json!({
                "projectId": project.id,
                "source": current,
                "title": title,
                "safeExcerpt": excerpt_text,
                "excerptTruncated": excerpt_truncated,
                "originalRef": {"fileId":file.id,"sha256":file.sha256,"sizeBytes":file.size_bytes},
            });
            if let Some(topic) = topic.as_ref().filter(|topic| !topic.is_empty()) {
                value["topic"] = Value::String((*topic).clone());
            }
            resolved.push(value);
        }
        Ok(Value::Array(resolved))
    }
}

fn project_row(db: &Connection, id: &str) -> Result<NativeProjectSnapshot, AppStorageError> {
    db.query_row(
        "SELECT id,workspace_path,ledger_project_id FROM projects WHERE id=?1",
        [id],
        |row| {
            Ok(NativeProjectSnapshot {
                id: row.get(0)?,
                workspace_path: row.get(1)?,
                ledger_project_id: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(AppStorageError::sqlite)?
    .ok_or_else(|| AppStorageError::new("project_not_found", "Project not found."))
}

fn read_app_source(
    db: &Connection,
    project_id: &str,
    source: &ProjectSourceReference,
) -> Result<AppSourceDocument, AppStorageError> {
    match source.kind.as_str() {
        "message" => read_message(db, project_id, source),
        "artifact" => read_artifact(db, project_id, source),
        _ => Err(AppStorageError::new(
            "source_unavailable",
            "Source unavailable.",
        )),
    }
}

fn read_message(
    db: &Connection,
    project_id: &str,
    source: &ProjectSourceReference,
) -> Result<AppSourceDocument, AppStorageError> {
    let row = db.query_row(
        "SELECT m.id,m.chat_id,c.title,m.text,m.updated_at,length(m.text),substr(m.text,1,1200) \
         FROM chats c JOIN messages m ON m.chat_id=c.id WHERE c.project_id=?1 AND m.id=?2 \
         AND m.role='assistant' AND m.status='delivered' \
         AND NOT (m.safe_error_code IS NOT NULL AND m.safe_error_code IN \
         ('app_turn_queue_failed','goal_completion_incomplete'))",
        params![project_id, source.id],
        |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,
                 row.get::<_, String>(3)?,row.get::<_, String>(4)?,row.get::<_, i64>(5)?,
                 row.get::<_, String>(6)?)),
    ).optional().map_err(AppStorageError::sqlite)?
        .ok_or_else(|| AppStorageError::new("source_unavailable", "Source unavailable."))?;
    let revision = digest(&row.3);
    let locator =
        serde_json::to_string(&json!([&row.0, &row.1, &row.4, row.5, &row.6])).map_err(|_| {
            AppStorageError::new("app_json_failed", "Source identity could not be encoded.")
        })?;
    if source.revision != digest(&locator) && source.revision != revision {
        return Err(AppStorageError::new(
            "source_changed",
            "Source changed. Reload it.",
        ));
    }
    Ok(AppSourceDocument {
        title: row.2,
        body: row.3,
        revision,
    })
}

fn read_artifact(
    db: &Connection,
    project_id: &str,
    source: &ProjectSourceReference,
) -> Result<AppSourceDocument, AppStorageError> {
    let Some(file_id) = source.id.strip_prefix("artifact-file-") else {
        return Err(AppStorageError::new(
            "source_unavailable",
            "Source unavailable.",
        ));
    };
    let file_id = format!("file-{file_id}");
    let row = db.query_row(
        "SELECT f.safe_name,f.sha256,f.created_at FROM chats c JOIN messages m ON m.chat_id=c.id \
         JOIN message_attachments a ON a.message_id=m.id JOIN message_files f ON f.id=a.file_id \
         WHERE c.project_id=?1 AND f.id=?2 AND m.role='assistant' AND m.status='delivered' \
         AND NOT (m.safe_error_code IS NOT NULL AND m.safe_error_code IN \
         ('app_turn_queue_failed','goal_completion_incomplete')) ORDER BY m.rowid DESC LIMIT 1",
        params![project_id, file_id],
        |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?)),
    ).optional().map_err(AppStorageError::sqlite)?
        .ok_or_else(|| AppStorageError::new("source_unavailable", "Source unavailable."))?;
    if source.revision != row.1 {
        return Err(AppStorageError::new(
            "source_changed",
            "Source changed. Reload it.",
        ));
    }
    Ok(AppSourceDocument {
        title: row.0,
        body: String::new(),
        revision: row.1,
    })
}

fn safe_document(body: String, data_root: &str, workspace_path: &str) -> String {
    let mut text = body;
    for root in [data_root, workspace_path]
        .into_iter()
        .filter(|root| root.len() > 1)
    {
        text = text.replace(root, "[local]");
    }
    let mut result = String::with_capacity(text.len());
    for (index, line) in text.split('\n').enumerate() {
        if index != 0 {
            result.push('\n');
        }
        let safe = sanitize_public_text(line, "");
        if safe == trim_js_whitespace(line) {
            result.push_str(line);
        } else {
            result.push_str(&safe);
        }
    }
    result
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn scope_changed() -> GatewayApplicationError {
    public(
        409,
        "project_source_scope_changed",
        "Project source scope changed.",
    )
}
