//! Immutable context documents use the existing BTCC SQLite owner and table.

use rusqlite::{Connection, OptionalExtension, params};

use super::common::btcc_error;
use super::{BtccRepositories, StorageError, StorageResult};
use crate::btcc::PortFuture;
use crate::btcc::identity::digest;

#[derive(Clone, Debug)]
pub(crate) struct ContextDocumentInput {
    pub scope_kind: String,
    pub scope_id: String,
    pub projection_class: String,
    pub source_id: String,
    pub source_revision: String,
    pub content: String,
}

#[derive(Debug, PartialEq)]
pub(crate) struct ContextDocumentRead {
    pub context_ref: String,
    pub content_sha256: String,
    pub scope_kind: String,
    pub scope_id: String,
    pub projection_class: String,
    pub source_id: String,
    pub source_revision: String,
    pub content: String,
}

impl BtccRepositories {
    pub(crate) fn persist_context_document(
        &self,
        input: ContextDocumentInput,
    ) -> PortFuture<'_, String> {
        Box::pin(async move {
            self.storage
                .execute(move |db| persist(db, input))
                .await
                .map_err(btcc_error)
        })
    }

    /// Legacy resolution checks content; the structured read additionally checks
    /// scope, public source identities and the complete context-reference hash.
    pub(crate) fn resolve_context_document(&self, reference: String) -> PortFuture<'_, String> {
        Box::pin(async move {
            self.storage
                .execute(move |db| resolve(db, &reference))
                .await
                .map_err(btcc_error)
        })
    }

    pub(crate) fn read_context_document(
        &self,
        reference: String,
    ) -> PortFuture<'_, ContextDocumentRead> {
        Box::pin(async move {
            self.storage
                .execute(move |db| read(db, &reference))
                .await
                .map_err(btcc_error)
        })
    }
}

fn persist(db: &Connection, input: ContextDocumentInput) -> StorageResult<String> {
    let content_sha256 = digest(&input.content);
    let reference = reference(
        &input.scope_kind,
        &input.scope_id,
        &input.projection_class,
        &input.source_id,
        &input.source_revision,
        &content_sha256,
    );
    db.execute(
        "INSERT OR IGNORE INTO btcc_context_documents \
         (context_ref, content_sha256, scope_kind, scope_id, projection_class, \
          source_id, source_revision, content, created_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![
            reference,
            content_sha256,
            input.scope_kind,
            input.scope_id,
            input.projection_class,
            input.source_id,
            input.source_revision,
            input.content
        ],
    )
    .map_err(StorageError::sqlite)?;
    Ok(reference)
}

fn resolve(db: &Connection, reference: &str) -> StorageResult<String> {
    let row: Option<(String, String)> = db
        .query_row(
            "SELECT content, content_sha256 FROM btcc_context_documents WHERE context_ref = ?1",
            [reference],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    match row {
        Some((content, hash)) if digest(&content) == hash => Ok(content),
        _ => Err(StorageError::new(
            "context_document_unavailable",
            format!("BTCC context document is unavailable or corrupt: {reference}"),
        )),
    }
}

fn read(db: &Connection, key: &str) -> StorageResult<ContextDocumentRead> {
    let row = db
        .query_row(
            "SELECT context_ref, content_sha256, scope_kind, scope_id, projection_class, \
         source_id, source_revision, content FROM btcc_context_documents WHERE context_ref = ?1",
            [key],
            |row| {
                Ok(ContextDocumentRead {
                    context_ref: row.get(0)?,
                    content_sha256: row.get(1)?,
                    scope_kind: row.get(2)?,
                    scope_id: row.get(3)?,
                    projection_class: row.get(4)?,
                    source_id: row.get(5)?,
                    source_revision: row.get(6)?,
                    content: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let invalid = || {
        StorageError::new(
            "btcc_context_document_identity_invalid",
            "btcc_context_document_identity_invalid",
        )
    };
    let row = row.ok_or_else(invalid)?;
    if !is_sha256(key)
        || row.context_ref != key
        || !is_sha256(&row.content_sha256)
        || digest(&row.content) != row.content_sha256
        || !matches!(
            row.projection_class.as_str(),
            "profile" | "recent_feedback" | "mandatory_hot_cache" | "optional_hot_cache"
        )
        || !matches!(row.scope_kind.as_str(), "user" | "session" | "project")
        || !is_public_identity(&row.source_id)
        || !is_public_identity(&row.source_revision)
        || reference(
            &row.scope_kind,
            &row.scope_id,
            &row.projection_class,
            &row.source_id,
            &row.source_revision,
            &row.content_sha256,
        ) != key
    {
        return Err(invalid());
    }
    Ok(row)
}

fn reference(
    scope: &str,
    scope_id: &str,
    class: &str,
    source: &str,
    revision: &str,
    hash: &str,
) -> String {
    digest(
        &[
            "btcc-context-document.v1",
            scope,
            scope_id,
            class,
            source,
            revision,
            hash,
        ]
        .join("\0"),
    )
}
fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
fn is_public_identity(value: &str) -> bool {
    (1..=160).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:@-".contains(&byte))
}

#[cfg(test)]
mod tests;
