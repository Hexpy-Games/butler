//! App SQLite owns upload rows and download identity; file I/O stays in its required port.

use rusqlite::{Connection, OptionalExtension, params};

use super::{
    AppApplication, AppFileDownload, AppFileUpload, AppMessageFileSnapshot, AppStorageError,
    GatewayApplicationError, app_error, public, read_model,
};
use crate::{
    gateway::{AppFileWrite, MessageFileRef},
    public_text::trim_js_whitespace,
};

impl AppApplication {
    pub(super) async fn upload_message_file(
        &self,
        input: AppFileUpload,
    ) -> Result<MessageFileRef, GatewayApplicationError> {
        let owner = input
            .owner_session_id
            .as_deref()
            .map(trim_js_whitespace)
            .filter(|owner| !owner.is_empty())
            .map(str::to_owned);
        if let Some(session_id) = owner.clone() {
            self.storage
                .execute(move |db| ensure_chat(db, &session_id))
                .await
                .map_err(app_error)?;
        }
        let written = self
            .dependencies
            .message_files
            .write_upload(AppFileWrite {
                name: input.name,
                mime_type: input.mime_type,
                bytes: input.bytes,
            })
            .await?;
        let row = self
            .storage
            .execute(move |db| insert_uploaded(db, owner, written))
            .await
            .map_err(app_error)?;
        self.dependencies
            .message_files
            .prepare_uploaded(row.clone())
            .await?;
        read_model::message_file_ref(&row).map_err(app_error)
    }

    pub(super) async fn download_message_file(
        &self,
        id: String,
    ) -> Result<AppFileDownload, GatewayApplicationError> {
        let row = self
            .storage
            .execute(move |db| downloadable(db, &id))
            .await
            .map_err(|error| {
                if error.code() == "message_file_not_found" {
                    public(404, error.code(), error.detail())
                } else {
                    app_error(error)
                }
            })?;
        let file = read_model::message_file_ref(&row).map_err(app_error)?;
        let bytes = self.dependencies.message_files.read_original(row).await?;
        Ok(AppFileDownload { file, bytes })
    }
}

fn ensure_chat(db: &Connection, id: &str) -> Result<(), AppStorageError> {
    let exists = db
        .query_row("SELECT id FROM chats WHERE id=?1", [id], |_| Ok(()))
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if exists.is_none() {
        return Err(AppStorageError::new(
            "unknown_chat",
            format!("Unknown chat: {id}"),
        ));
    }
    Ok(())
}

fn insert_uploaded(
    db: &Connection,
    owner: Option<String>,
    file: super::MaterializedResponderFile,
) -> Result<AppMessageFileSnapshot, AppStorageError> {
    db.execute(
        "INSERT INTO message_files (id,owner_session_id,message_id,kind,mime_type,safe_name,\
         size_bytes,sha256,storage_name,created_at) VALUES (?1,?2,NULL,?3,?4,?5,?6,?7,?8,?9)",
        params![
            file.id,
            owner,
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
    super::admission::file(db, &file.id)?
        .ok_or_else(|| AppStorageError::new("message_file_not_found", "Attachment file not found."))
}

fn downloadable(db: &Connection, id: &str) -> Result<AppMessageFileSnapshot, AppStorageError> {
    let row = super::admission::file(db, id)?.ok_or_else(not_found)?;
    if row.storage_name != row.id || !valid_file_id(&row.storage_name) {
        return Err(not_found());
    }
    Ok(row)
}

fn valid_file_id(id: &str) -> bool {
    let (Some(prefix), Some(tail)) = (id.get(..5), id.get(5..)) else {
        return false;
    };
    prefix.eq_ignore_ascii_case("file-")
        && tail.len() == 36
        && tail
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn not_found() -> AppStorageError {
    AppStorageError::new("message_file_not_found", "Attachment file not found.")
}
