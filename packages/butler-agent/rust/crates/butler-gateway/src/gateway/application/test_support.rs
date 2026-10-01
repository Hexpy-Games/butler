use super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};

pub(crate) async fn seed_test_assistant_attachment(
    application: &AppApplication,
    session_id: &str,
    message_id: &str,
    file_id: &str,
) -> Result<(), GatewayApplicationError> {
    let session_id = session_id.to_owned();
    let message_id = message_id.to_owned();
    let file_id = file_id.to_owned();
    application
        .storage
        .execute(move |db| {
            db.execute(
                "INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at) \
                 VALUES(?1,?2,?3,'assistant','artifact response','delivered',?4,?4)",
                rusqlite::params![
                    message_id,
                    session_id,
                    "turn-artifact",
                    "2026-09-14T00:00:00.000Z"
                ],
            )
            .map_err(AppStorageError::sqlite)?;
            db.execute(
                "INSERT INTO message_files(id,owner_session_id,message_id,kind,mime_type,safe_name,size_bytes,sha256,storage_name,created_at) \
                 VALUES(?1,?2,?3,'image','image/png','plot.png',7,'sha-artifact','plot.png',?4)",
                rusqlite::params![
                    file_id,
                    session_id,
                    message_id,
                    "2026-09-14T00:00:00.000Z"
                ],
            )
            .map_err(AppStorageError::sqlite)?;
            db.execute(
                "INSERT INTO message_attachments(message_id,file_id,position) VALUES(?1,?2,0)",
                rusqlite::params![message_id, file_id],
            )
            .map_err(AppStorageError::sqlite)?;
            Ok(())
        })
        .await
        .map_err(app_error)
}
