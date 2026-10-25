use super::super::storage::AppStorageCode;
use super::*;
use rusqlite::{OptionalExtension, params};
pub(super) fn invalid(message: &str) -> AppStorageError {
    AppStorageError::new(AppStorageCode::InvalidDocumentRequest, message)
}
pub(super) fn missing() -> AppStorageError {
    AppStorageError::new(
        AppStorageCode::DocumentNotFound,
        "Document or revision not found.",
    )
}
pub(super) fn body(value: &Value) -> &str {
    value["body"].as_str().unwrap_or_default()
}
pub(super) fn positive(input: &Value, key: &str) -> Result<i64, AppStorageError> {
    input[key]
        .as_i64()
        .filter(|n| *n > 0)
        .ok_or_else(|| invalid("Revision must be a positive integer."))
}
pub(in crate::gateway::application) fn revision(
    db: &Connection,
    id: &str,
    rev: i64,
) -> Result<Value, AppStorageError> {
    db.query_row("SELECT d.id,d.title,d.chat_id,d.message_id,r.rev,b.body,r.updated_at,r.author,r.created_at FROM documents d JOIN document_revisions r ON r.document_id=d.id JOIN document_bodies b ON b.sha256=r.sha256 WHERE d.id=?1 AND r.rev=?2", params![id,rev], |r| {
        Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"chat_id":r.get::<_,Option<String>>(2)?,"message_id":r.get::<_,Option<String>>(3)?,"rev":r.get::<_,i64>(4)?,"body":r.get::<_,String>(5)?,"updated_at":r.get::<_,String>(6)?,"author":r.get::<_,String>(7)?,"created_at":r.get::<_,String>(8)?,"assets":butler_runtime::documents::parse(&r.get::<_,String>(5)?).images.into_iter().map(|id| json!({"id":id,"url":format!("/message-assets/{id}")})).collect::<Vec<_>>()}))
    }).optional().map_err(AppStorageError::sqlite)?.ok_or_else(missing)
}
pub(in crate::gateway::application) fn head(
    db: &Connection,
    id: &str,
) -> Result<Value, AppStorageError> {
    let rev = db
        .query_row("SELECT head_rev FROM documents WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(AppStorageError::sqlite)?
        .ok_or_else(missing)?;
    revision(db, id, rev)
}
pub(in crate::gateway::application) fn revisions(
    db: &Connection,
    id: &str,
) -> Result<Value, AppStorageError> {
    head(db, id)?;
    let mut stmt = db.prepare_cached("SELECT r.rev,r.author,r.created_at,r.updated_at,length(CAST(b.body AS BLOB)) FROM document_revisions r JOIN document_bodies b ON b.sha256=r.sha256 WHERE r.document_id=?1 ORDER BY r.rev DESC").map_err(AppStorageError::sqlite)?;
    let values = stmt.query_map([id], |r| Ok(json!({"rev":r.get::<_,i64>(0)?,"author":r.get::<_,String>(1)?,"created_at":r.get::<_,String>(2)?,"updated_at":r.get::<_,String>(3)?,"size":r.get::<_,i64>(4)?}))).map_err(AppStorageError::sqlite)?.collect::<Result<Vec<_>,_>>().map_err(AppStorageError::sqlite)?;
    Ok(json!(values))
}
pub(super) fn prune(db: &Connection, hash: &str) -> Result<(), AppStorageError> {
    db.execute("DELETE FROM document_bodies WHERE sha256=?1 AND NOT EXISTS(SELECT 1 FROM document_revisions WHERE sha256=?1)", [hash]).map_err(AppStorageError::sqlite)?;
    Ok(())
}
pub(in crate::gateway::application) fn delete(
    db: &Connection,
    id: &str,
) -> Result<(), AppStorageError> {
    let hashes = db
        .prepare_cached("SELECT sha256 FROM document_revisions WHERE document_id=?1")
        .map_err(AppStorageError::sqlite)?
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    db.execute("DELETE FROM documents WHERE id=?1", [id])
        .map_err(AppStorageError::sqlite)?;
    for hash in hashes {
        prune(db, &hash)?;
    }
    Ok(())
}

/// Bind newly created deliverable references to the assistant's durable reply.
pub(in crate::gateway::application) fn bind_reply(
    db: &Connection,
    chat: &str,
    original: Option<&str>,
    reply: &str,
) -> Result<(), AppStorageError> {
    let Some(original) = original else {
        return Ok(());
    };
    let ids = db
        .prepare_cached("SELECT id FROM documents WHERE chat_id=?1 AND message_id=?2")
        .map_err(AppStorageError::sqlite)?
        .query_map(params![chat, original], |r| r.get::<_, String>(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    for id in ids {
        db.execute(
            "UPDATE documents SET message_id=?2 WHERE id=?1",
            params![id, reply],
        )
        .map_err(AppStorageError::sqlite)?;
        db.execute("UPDATE browser_library SET payload=json_set(payload,'$.message',?2) WHERE id=?1 AND kind='doc'",params![id,reply]).map_err(AppStorageError::sqlite)?;
    }
    db.execute(
        "UPDATE document_deliveries SET message_id=?3 WHERE chat_id=?1 AND message_id=?2",
        params![chat, original, reply],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

pub(super) fn delivery(db: &Connection, id: &str, input: &Value) -> Result<(), AppStorageError> {
    if input["author"] != "butler" {
        return Ok(());
    }
    if let (Some(chat), Some(message)) = (input["chat_id"].as_str(), input["message_id"].as_str()) {
        db.execute(
            "INSERT OR IGNORE INTO document_deliveries VALUES(?1,?2,?3)",
            params![id, chat, message],
        )
        .map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}

pub(in crate::gateway::application) fn has_deliverable(
    db: &Connection,
    chat: &str,
    original: Option<&str>,
) -> Result<bool, AppStorageError> {
    let Some(original) = original else {
        return Ok(false);
    };
    db.query_row(
        "SELECT 1 FROM documents WHERE chat_id=?1 AND message_id=?2 UNION ALL SELECT 1 FROM document_deliveries WHERE chat_id=?1 AND message_id=?2 LIMIT 1",
        params![chat, original],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(AppStorageError::sqlite)
}
