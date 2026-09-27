use super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};

pub(crate) async fn seed_test_transcript_messages(
    application: &AppApplication,
    session_id: &str,
    title: &str,
    rows: Vec<(String, String, Option<String>)>,
) -> Result<(), GatewayApplicationError> {
    let session_id = session_id.to_owned();
    let title = title.to_owned();
    application
        .storage
        .execute(move |db| {
            let transaction = db.transaction().map_err(AppStorageError::sqlite)?;
            transaction
                .execute(
                    "UPDATE chats SET title=?1 WHERE id=?2",
                    rusqlite::params![title, session_id],
                )
                .map_err(AppStorageError::sqlite)?;
            for (index, (role, text, safe_error_code)) in rows.into_iter().enumerate() {
                transaction
                    .execute(
                        "INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at,safe_error_code) VALUES(?1,?2,?3,?4,'delivered',?5,?5,?6)",
                        rusqlite::params![
                            format!("transcript-message-{index:04}"),
                            session_id,
                            role,
                            text,
                            "2026-09-14T00:00:00.000Z",
                            safe_error_code
                        ],
                    )
                    .map_err(AppStorageError::sqlite)?;
            }
            transaction.commit().map_err(AppStorageError::sqlite)
        })
        .await
        .map_err(app_error)
}

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

pub(crate) async fn seed_test_authority_queue(
    application: &AppApplication,
    queued_message_id: &str,
) -> Result<(), GatewayApplicationError> {
    let id = queued_message_id.to_owned();
    let now = application.dependencies.identity_clock.now_iso();
    application
        .storage
        .execute(move |db| {
            db.execute(
                "INSERT INTO session_queued_messages (id,chat_id,text,client_message_id,input_identity_digest,control_resolution_json,controls_json,attachments_json,project_source_refs_json,state,created_at,updated_at) VALUES (?1,'general','approved command','authority-client','authority-digest',?2,?3,'[]','[]','queued',?4,?4)",
                rusqlite::params![
                    id,
                    serde_json::json!({
                        "authority_request_ref": "allow-1",
                        "controls": {
                            "model": "openai/gpt-5.5",
                            "reasoning_effort": "medium",
                            "access_mode": "full_access",
                            "plan_mode": false
                        },
                        "source": "global_default",
                        "sessionControlRevision": 0,
                        "catalogGeneration": "test"
                    })
                    .to_string(),
                    serde_json::json!({
                        "model": "openai/gpt-5.5",
                        "reasoning_effort": "medium",
                        "access_mode": "full_access",
                        "plan_mode": false
                    })
                    .to_string(),
                    now
                ],
            )
            .map_err(AppStorageError::sqlite)?;
            Ok(())
        })
        .await
        .map_err(app_error)
}
