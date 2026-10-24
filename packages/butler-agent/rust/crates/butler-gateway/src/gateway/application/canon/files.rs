//! Keyed reference reconciliation and change-driven, durable file cleanup.
use super::super::storage::schema::canon_files::{
    DELETE_EXPIRED, DELETE_PENDING, DELETE_UNUSED, EPIC_FILES, EXPIRED, REMOVE_REFS, REMOVE_SWEEP,
    SWEEP_QUEUE,
};
use super::super::*;
use crate::gateway::MessageFileRef;
use rusqlite::{Connection, params};

pub(in crate::gateway::application) fn replace(
    db: &Connection,
    payload: &Value,
) -> Result<(), AppStorageError> {
    if payload["kind"] != "work" {
        return Ok(());
    }
    let Some(ids) = payload["attachments"].as_array() else {
        return Ok(());
    };
    let epic = payload["id"].as_str().unwrap_or_default();
    // Insert first: retained references never transiently lose their lifetime.
    for id in ids {
        db.execute(
            "INSERT OR IGNORE INTO app_canon_epic_files VALUES(?1,?2)",
            params![epic, id.as_str()],
        )
        .map_err(AppStorageError::sqlite)?;
        db.execute(DELETE_PENDING, [id.as_str()])
            .map_err(AppStorageError::sqlite)?;
    }
    db.execute(
        REMOVE_REFS,
        params![epic, Value::Array(ids.clone()).to_string()],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

pub(in crate::gateway::application) fn list(
    db: &Connection,
    epic: &str,
) -> Result<Value, AppStorageError> {
    let mut stmt = db.prepare(EPIC_FILES).map_err(AppStorageError::sqlite)?;
    let ids = stmt
        .query_map([epic], |r| r.get::<_, String>(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let mut files = Vec::new();
    for id in ids {
        if let Some(row) = admission::file(db, &id)? {
            files.push(read_model::message_file_ref(&row)?);
        }
    }
    Ok(serde_json::json!(files))
}

/// Shared with chat proposals: PK ownership checks precede any description change.
pub(in crate::gateway::application) fn append_session_references(
    db: &Connection,
    session: &str,
    description: &str,
    file_ids: &[String],
) -> Result<String, GatewayApplicationError> {
    let existing = butler_canon::attachments::references(description)
        .map_err(|_| public(400, "invalid_attachments", "Invalid attachments."))?;
    let mut result = description.to_owned();
    let mut seen: std::collections::BTreeSet<_> = existing.into_iter().collect();
    for id in file_ids {
        let row = admission::file(db, id).map_err(app_error)?;
        if row.is_none_or(|row| row.owner_session_id.as_deref() != Some(session)) {
            return Err(public(
                400,
                "invalid_attachment_owner",
                "Attachment belongs to another chat.",
            ));
        }
        if seen.insert(id.clone()) {
            result.push_str(&format!("\n![](attachment:{id})"));
        }
    }
    butler_canon::attachments::references(&result)
        .map_err(|_| public(400, "invalid_attachments", "Invalid attachments."))?;
    Ok(result)
}

pub(in crate::gateway::application) async fn upload(
    app: &AppApplication,
    project: String,
    input: AppFileUpload,
) -> Result<MessageFileRef, GatewayApplicationError> {
    super::validate_scope(
        app,
        &AppCanonRequest {
            resource: AppCanonResource::Canon,
            id: project,
            input: None,
        },
    )
    .await?;
    {
        let _files = app.canon_file_lifetimes.lock().await;
        sweep(app, true).await?;
    }
    let mut written = app
        .dependencies
        .message_files
        .write_upload(AppFileWrite {
            name: input.name,
            mime_type: input.mime_type,
            bytes: input.bytes,
        })
        .await?;
    if !matches!(written.kind.as_str(), "image" | "text") && written.mime_type != "application/pdf"
    {
        written.mime_type = "application/octet-stream".into();
    }
    let expires = app
        .dependencies
        .identity_clock
        .iso_after_millis(24 * 60 * 60 * 1000);
    let row = app
        .storage
        .execute(move |db| {
            let row = message_files::insert_uploaded(db, None, &written)?;
            db.execute(
                "INSERT INTO app_file_pending VALUES(?1,?2)",
                params![row.id, expires],
            )
            .map_err(AppStorageError::sqlite)?;
            Ok(row)
        })
        .await
        .map_err(app_error)?;
    app.dependencies
        .message_files
        .prepare_uploaded(row.clone())
        .await?;
    read_model::message_file_ref(&row).map_err(app_error)
}

pub(super) async fn sweep(
    app: &AppApplication,
    expire: bool,
) -> Result<(), GatewayApplicationError> {
    let now = app.dependencies.identity_clock.now_iso();
    let ids = app
        .storage
        .execute(move |db| {
            if expire {
                db.execute(
                    &format!("INSERT OR IGNORE INTO app_file_sweep {EXPIRED}"),
                    [&now],
                )
                .map_err(AppStorageError::sqlite)?;
                db.execute(DELETE_EXPIRED, [&now])
                    .map_err(AppStorageError::sqlite)?;
            }
            let mut stmt = db.prepare(SWEEP_QUEUE).map_err(AppStorageError::sqlite)?;
            let ids = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(AppStorageError::sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(AppStorageError::sqlite)?;
            let mut removed = Vec::new();
            for id in ids {
                // The SQLite lane serializes this decision with new references.
                db.execute(DELETE_UNUSED, [&id])
                    .map_err(AppStorageError::sqlite)?;
                let exists = admission::file(db, &id)?.is_some();
                if exists {
                    db.execute(REMOVE_SWEEP, [&id])
                        .map_err(AppStorageError::sqlite)?;
                } else {
                    removed.push(id);
                }
            }
            Ok(removed)
        })
        .await
        .map_err(app_error)?;
    for id in ids {
        app.dependencies
            .message_files
            .remove_original(id.clone())
            .await?;
        app.storage
            .execute(move |db| {
                db.execute(REMOVE_SWEEP, [id])
                    .map_err(AppStorageError::sqlite)?;
                Ok(())
            })
            .await
            .map_err(app_error)?;
    }
    Ok(())
}

impl AppApplication {
    /// Shared with canon proposals; keeps file ownership in the App database.
    pub fn append_canon_session_files(
        &self,
        session: String,
        description: String,
        ids: Vec<String>,
    ) -> ApplicationFuture<String> {
        let app = self.clone_handle();
        Box::pin(async move {
            app.storage
                .read(move |db| Ok(append_session_references(db, &session, &description, &ids)))
                .await
                .map_err(app_error)?
        })
    }
}

/// Reject absent uploads before canon can commit a reference into its outbox.
pub(super) async fn validate_write(
    app: &AppApplication,
    request: &AppCanonRequest,
) -> Result<(), GatewayApplicationError> {
    if !matches!(
        request.resource,
        AppCanonResource::CreateEpic | AppCanonResource::EditEpic
    ) {
        return Ok(());
    }
    let Some(description) = request
        .input
        .as_ref()
        .and_then(|v| v["description"].as_str())
    else {
        return Ok(());
    };
    let ids = butler_canon::attachments::references(description)
        .map_err(|_| public(400, "invalid_attachments", "Invalid attachments."))?;
    let expires = app
        .dependencies
        .identity_clock
        .iso_after_millis(24 * 60 * 60 * 1000);
    let valid = app
        .storage
        .execute(move |db| {
            for id in &ids {
                if admission::file(db, id)?.is_none() {
                    return Ok(false);
                }
            }
            // A pending write pins its files until the outbox installs the references.
            // This closes the cross-owner handoff against a concurrent expiry/sweep.
            for id in ids {
                db.execute(
                    "INSERT INTO app_file_pending VALUES(?1,?2)
                ON CONFLICT(file_id) DO UPDATE SET expires_at=excluded.expires_at",
                    params![id, expires],
                )
                .map_err(AppStorageError::sqlite)?;
            }
            Ok(true)
        })
        .await
        .map_err(app_error)?;
    if !valid {
        return Err(public(
            400,
            "attachment_not_found",
            "Attachment file not found.",
        ));
    }
    Ok(())
}
