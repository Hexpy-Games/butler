//! Archive the general channel's conversation while retaining its permanent identity.
use super::{identity::runtime_hint, read};
use crate::gateway::application::{
    AppApplication, AppIdentityClock, AppStorageError, app_error, events,
};
use crate::gateway::{AppEventEnvelope, GatewayApplicationError};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

impl AppApplication {
    pub(crate) async fn clear_general_owned(
        &self,
        title: String,
    ) -> Result<Value, GatewayApplicationError> {
        let _guard = self.space_mutations.lock_relocation("general").await?;
        let hint = self.runtime_hint("general").await?;
        let snapshot = self
            .dependencies
            .relocation_host
            .inspect(hint.clone())
            .await?;
        let authority = self.dependencies.authority_handoff.list(hint).await?;
        if snapshot.active_execution || snapshot.open_child || !authority.requests.is_empty() {
            return Err(busy());
        }
        // Drain already committed output before transferring its checkpoint and ownership.
        self.projection.refresh("general".to_owned()).await?;
        let clock = self.dependencies.identity_clock.clone();
        let (result, event) = self
            .storage
            .execute(move |db| Ok(clear(db, &title, clock.as_ref())))
            .await
            .map_err(app_error)??;
        self.recover_output_transfers().await?;
        events::publish(&self.subscribers, &event);
        Ok(result)
    }
}

fn clear(
    db: &mut Connection,
    title: &str,
    clock: &dyn AppIdentityClock,
) -> Result<(Value, AppEventEnvelope), GatewayApplicationError> {
    let tx = db.savepoint().map_err(sql_error)?;
    let busy_now: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM turns WHERE chat_id='general' AND (state NOT IN ('delivered','cancelled','failed','runtime_fault') OR retryable=1)) OR EXISTS(SELECT 1 FROM session_queued_messages WHERE chat_id='general' AND state IN ('queued','dispatching')) OR EXISTS(SELECT 1 FROM app_session_context_gate WHERE session_id='general')",
        [], |row| row.get(0)).map_err(sql_error)?;
    if busy_now {
        return Err(busy());
    }
    let archived_id = format!("general-archive-{}", clock.new_uuid());
    let fresh_hint = crate::gateway::app_session_hint(&format!("general-{}", clock.new_uuid()));
    let old_hint = runtime_hint(&tx, "general").map_err(app_error)?;
    let now = clock.now_iso();
    tx.execute("INSERT INTO chats(id,title,kind,project_id,conversation_session_id,runtime_session_hint,pinned,archived,created_at,updated_at) SELECT ?1,?2,kind,project_id,conversation_session_id,NULL,0,1,created_at,?3 FROM chats WHERE id='general'", params![archived_id,title,now]).map_err(sql_error)?;
    transfer_history(&tx, &archived_id)?;
    tx.execute("UPDATE chats SET conversation_session_id=NULL,runtime_session_hint=?1,updated_at=?2 WHERE id='general'", params![fresh_hint,now]).map_err(sql_error)?;
    tx.execute(
        "UPDATE chats SET runtime_session_hint=?1 WHERE id=?2",
        params![old_hint, archived_id],
    )
    .map_err(sql_error)?;
    let session = read::session(&tx, "general").map_err(app_error)?;
    let archived = read::session(&tx, &archived_id).map_err(app_error)?;
    let event = events::append_unpublished(
        &tx,
        "session.cleared",
        None,
        butler_core::json::json_object!({"session":session,"archived_session":archived}),
        &now,
    )
    .map_err(app_error)?;
    tx.commit().map_err(sql_error)?;
    Ok((
        json!({"session":session,"archived_session":archived,"event_id":event.id}),
        event,
    ))
}

fn transfer_history(db: &Connection, archived: &str) -> Result<(), GatewayApplicationError> {
    // Preserve message rowids and FTS text. Attachments, progress and outputs are
    // owned through unchanged message/turn ids; the transcript stays at its canonical path.
    for (table, column) in [
        ("app_space_topics", "session_id"),
        ("messages", "chat_id"),
        ("turns", "chat_id"),
        ("session_queued_messages", "chat_id"),
        ("session_queue_pauses", "chat_id"),
        ("app_terminal_turn_projections", "chat_id"),
        ("app_transcript_projection_checkpoints", "chat_id"),
        ("projected_transport_events", "chat_id"),
        ("app_transport_projection_receipts", "chat_id"),
        ("app_transport_projection_staged_outbounds", "chat_id"),
    ] {
        db.execute(
            &format!("UPDATE {table} SET {column}=?1 WHERE {column}='general'"),
            [archived],
        )
        .map_err(sql_error)?;
    }
    db.execute("UPDATE message_files SET owner_session_id=?1 WHERE owner_session_id='general' AND message_id IN (SELECT id FROM messages WHERE chat_id=?1)", [archived]).map_err(sql_error)?;
    db.execute(
        "INSERT INTO app_output_transfers(archive_id) VALUES(?1)",
        [archived],
    )
    .map_err(sql_error)?;
    // Existing relocation admission blocks publication until cross-store recovery completes.
    db.execute("INSERT INTO app_session_context_gate(session_id,owner_kind,owner_id) VALUES('general','relocate',?1)", [archived]).map_err(sql_error)?;
    db.execute(
        "UPDATE app_automation_runs SET target_session_id=?1 WHERE target_session_id='general' AND (EXISTS(SELECT 1 FROM turns WHERE id=app_automation_runs.turn_id AND chat_id=?1) OR EXISTS(SELECT 1 FROM session_queued_messages WHERE id=app_automation_runs.queued_message_id AND chat_id=?1))",
        [archived],
    ).map_err(sql_error)?;
    db.execute("DELETE FROM app_work_monitor WHERE chat_id='general'", [])
        .map_err(sql_error)?;
    db.execute(
        "INSERT OR IGNORE INTO app_work_monitor_dirty(chat_id) VALUES(?1),('general')",
        [archived],
    )
    .map_err(sql_error)?;
    Ok(())
}
fn busy() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 409,
        code: "session_busy".into(),
        message: "Wait for this chat's pending work to finish.".into(),
        source: None,
    }
}
fn sql_error(error: rusqlite::Error) -> GatewayApplicationError {
    app_error(AppStorageError::sqlite(error))
}
