//! At most 200 attachments per conversation; thereafter overwrite the latest tab slot.
use super::{
    AppApplication, AppFileUpload, AppFileWrite, AppMessageFileSnapshot, AppStorageError,
    GatewayApplicationError, app_error, read_model,
};
use crate::gateway::MessageFileRef;
use rusqlite::{Connection, params};
impl AppApplication {
    pub(super) async fn upload_browser_still(
        &self,
        input: AppFileUpload,
        tab: String,
    ) -> Result<MessageFileRef, GatewayApplicationError> {
        let owner = input
            .owner_session_id
            .clone()
            .ok_or_else(GatewayApplicationError::internal)?;
        if input.bytes.len() > 24 * 1024 || input.mime_type.as_deref() != Some("image/jpeg") {
            return Err(GatewayApplicationError::internal());
        }
        let name = format!("browser-step-{tab}.jpg");
        let query_tab = tab.clone();
        let prior = self
            .storage
            .execute(move |db| slot(db, &owner, &query_tab))
            .await
            .map_err(app_error)?;
        let file = if let Some(prior) = prior {
            self.dependencies
                .message_files
                .replace_browser_still(prior, input.bytes, name)
                .await?
        } else {
            self.dependencies
                .message_files
                .write_upload(AppFileWrite {
                    name,
                    mime_type: input.mime_type,
                    bytes: input.bytes,
                })
                .await?
        };
        let owner = input.owner_session_id.unwrap_or_default();
        let row = self
            .storage
            .execute(move |db| {
                let exists = db
                    .query_row(
                        "SELECT COUNT(*) FROM message_files WHERE id=?1",
                        [&file.id],
                        |r| r.get::<_, i64>(0),
                    )
                    .map_err(AppStorageError::sqlite)?;
                if exists > 0 {
                    db.execute(
                        "UPDATE message_files SET safe_name=?2,size_bytes=?3,sha256=?4 WHERE id=?1",
                        params![file.id, file.safe_name, file.size_bytes, file.sha256],
                    )
                    .map_err(AppStorageError::sqlite)?;
                    db.execute("UPDATE browser_stills SET tab_id=?2 WHERE file_id=?1", params![file.id, tab]).map_err(AppStorageError::sqlite)?;
                    super::admission::file(db, &file.id)?.ok_or_else(|| {
                        AppStorageError::new(
                            super::storage::AppStorageCode::MessageFileNotFound,
                            "Browser still missing",
                        )
                    })
                } else {
                    let row = super::message_files::insert_uploaded(db, Some(&owner), &file)?;
                    db.execute("INSERT INTO browser_stills(file_id,owner_session_id,tab_id,created_at) SELECT id,owner_session_id,?2,created_at FROM message_files WHERE id=?1", params![file.id, tab]).map_err(AppStorageError::sqlite)?;
                    Ok(row)
                }
            })
            .await
            .map_err(app_error)?;
        read_model::message_file_ref(&row).map_err(app_error)
    }
}
fn slot(
    db: &Connection,
    owner: &str,
    tab: &str,
) -> Result<Option<AppMessageFileSnapshot>, AppStorageError> {
    let mut query=db.prepare("SELECT file_id,tab_id FROM browser_stills WHERE owner_session_id=?1 ORDER BY created_at LIMIT 200").map_err(AppStorageError::sqlite)?;
    let rows = query
        .query_map([owner], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    if rows.len() < 200 {
        return Ok(None);
    }
    let id = rows
        .iter()
        .rev()
        .find(|(_, n)| n == tab)
        .or_else(|| rows.first())
        .map(|(id, _)| id.as_str())
        .unwrap_or("");
    super::admission::file(db, id)
}
