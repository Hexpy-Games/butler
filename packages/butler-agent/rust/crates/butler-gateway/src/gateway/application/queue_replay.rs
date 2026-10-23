//! A kept request reuses its admitted controls, content and source references.
use super::{AppApplication, GatewayApplicationError, app_error, queue};
use rusqlite::params;
impl AppApplication {
    pub(super) async fn replay_kept_request_owned(
        &self,
        chat: String,
        source: String,
        receipt: String,
    ) -> Result<(), GatewayApplicationError> {
        let client = format!("cutover-message:{receipt}");
        let id = format!("queued-cutover:{receipt}");
        let now = self.dependencies.identity_clock.now_iso();
        let wake_chat = chat.clone();
        self.storage.execute(move |db| {
            let tx = db.savepoint().map_err(super::AppStorageError::sqlite)?;
            let row = tx.query_row("SELECT text,input_identity_digest,control_resolution_json,controls_json,attachments_json,content_parts_json,project_source_refs_json FROM session_queued_messages WHERE chat_id=?1 AND client_message_id=?2", params![chat,source], |r| Ok(queue::QueueReservation {
                id:id.clone(),chat_id:chat.clone(),client_message_id:client,
                text:r.get(0)?,input_identity_digest:r.get(1)?,control_resolution_json:r.get(2)?,controls_json:r.get(3)?,attachments_json:r.get(4)?,content_parts_json:r.get(5)?,project_source_refs_json:r.get(6)?,created_at:now,
            })).map_err(super::AppStorageError::sqlite)?;
            queue::reserve(&tx,&row)?;
            tx.execute("UPDATE session_queued_messages SET replay_source_message_id=?1 WHERE id=?2 AND replay_source_message_id IS NULL", params![source,id]).map_err(super::AppStorageError::sqlite)?;
            tx.commit().map_err(super::AppStorageError::sqlite)
        }).await.map_err(app_error)?;
        self.queue_wake.chat(wake_chat).await
    }
}
