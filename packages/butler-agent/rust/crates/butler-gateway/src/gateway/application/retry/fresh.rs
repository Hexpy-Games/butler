//! Atomic consumption and durable identity of a fresh retry.
use super::*;
use rusqlite::OptionalExtension;

pub(in crate::gateway::application) fn consume_fresh_retry(
    db: &Connection,
    subscribers: &events::EventSubscribers,
    source: &str,
    reservation: &queue::QueueReservation,
) -> Result<bool, AppStorageError> {
    current_controls_retry_source(db, source)?;
    let inserted = queue::reserve(db, reservation)?;
    if !inserted {
        return Ok(false);
    }
    let changed = db.execute(
        "UPDATE turns SET retryable=0,fresh_retry_queue_id=?1 WHERE id=?2 AND retryable=1 AND fresh_retry_queue_id IS NULL",
        params![reservation.id, source],
    ).map_err(AppStorageError::sqlite)?;
    if changed != 1 {
        return Err(not_retryable_error());
    }
    db.execute("UPDATE messages SET retryable=0,retry_mode=NULL,retry_with_current_controls=0 WHERE turn_id=?1 AND chat_id=?2 AND role='assistant' AND status='failed'", params![source,reservation.chat_id])
        .map_err(AppStorageError::sqlite)?;
    let turn = read_model::exact_turn(db, source)?;
    events::append(
        db,
        subscribers,
        "turn.state_changed",
        Some(source),
        service::map(&json!({"turn":turn}))?,
        &reservation.created_at,
    )?;
    let mut statement = db.prepare("SELECT id FROM messages WHERE turn_id=?1 AND chat_id=?2 AND role='assistant' AND status='failed'").map_err(AppStorageError::sqlite)?;
    let ids = statement
        .query_map(params![source, reservation.chat_id], |r| {
            r.get::<_, String>(0)
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    for id in ids {
        let message = read_model::exact_message(db, &reservation.chat_id, &id)?;
        events::append(
            db,
            subscribers,
            "message.updated",
            Some(source),
            service::map(&json!({"message":message}))?,
            &reservation.created_at,
        )?;
    }
    Ok(true)
}

impl AppApplication {
    pub(super) async fn existing_fresh_retry(
        &self,
        source: &str,
    ) -> Result<Option<MessageSendResult>, GatewayApplicationError> {
        let source = source.to_owned();
        let link = self.storage.execute(move |db| {
            db.query_row("SELECT q.chat_id,q.client_message_id,q.turn_id FROM turns t JOIN session_queued_messages q ON q.id=t.fresh_retry_queue_id WHERE t.id=?1",
                [source], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?)))
                .optional().map_err(AppStorageError::sqlite)
        }).await.map_err(app_error)?;
        let Some((chat, client, turn)) = link else {
            return Ok(None);
        };
        let mut result = self.queued_result(&chat, &client).await?;
        if let Some(turn) = turn {
            result.turn = self
                .storage
                .execute(move |db| read_model::exact_turn(db, &turn))
                .await
                .map_err(app_error)?;
        }
        Ok(Some(result))
    }
}
