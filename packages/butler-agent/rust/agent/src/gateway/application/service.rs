//! Transactional admission, queue recovery, and dispatch helpers.

use super::*;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};

impl AppApplication {
    pub(super) async fn fence_claim(
        &self,
        claim: &QueueClaim,
        turn_id: &str,
    ) -> Result<bool, GatewayApplicationError> {
        let chat = claim.chat_id.clone();
        let turn = turn_id.to_owned();
        let claim_id = claim.claim_id.clone();
        self.storage
            .execute(move |db| queue::fence(db, &chat, &turn, &claim_id))
            .await
            .map_err(app_error)
    }

    pub(super) async fn publish_native_queued(
        &self,
        claim: &QueueClaim,
        turn_id: &str,
        receipt: &NativeEnqueueReceipt,
    ) -> Result<(), GatewayApplicationError> {
        let chat = claim.chat_id.clone();
        let turn = turn_id.to_owned();
        let queue_id = receipt.queue_id.clone();
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        self.storage
            .execute(move |db| {
                let controls: String = db
                    .query_row(
                        "SELECT execution_controls_json FROM turns WHERE id=?1",
                        [&turn],
                        |row| row.get(0),
                    )
                    .map_err(AppStorageError::sqlite)?;
                let controls: Value = serde_json::from_str(&controls).map_err(|error| {
                    AppStorageError::new("app_projection_json_invalid", error.to_string())
                })?;
                events::append(
                    db,
                    &subscribers,
                    "turn.queued",
                    Some(&turn),
                    map(json!({"session_id":chat,"turn_id":turn,"transport":"app",
                        "queue_id":queue_id,"requested_model_ref":controls.get("model_ref"),
                        "reasoning_effort":controls.get("reasoning_effort")}))?,
                    &now,
                )?;
                Ok(())
            })
            .await
            .map_err(app_error)
    }

    pub(super) async fn claimed_dispatch(
        &self,
        claim: &QueueClaim,
    ) -> Result<Option<ClaimedDispatch>, GatewayApplicationError> {
        let queued = claim.queued_message_id.clone();
        let fence = claim.claim_id.clone();
        self.storage
            .execute(move |db| {
                let linked = db
                    .query_row(
                        "SELECT q.dispatched_message_id,q.turn_id FROM session_queued_messages q \
                         WHERE q.id=?1 AND q.state='dispatching' AND q.claim_id=?2",
                        params![queued, fence],
                        |row| {
                            Ok((
                                row.get::<_, Option<String>>(0)?,
                                row.get::<_, Option<String>>(1)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(AppStorageError::sqlite)?;
                match linked {
                    None | Some((None, None)) => Ok(None),
                    Some((Some(message_id), Some(turn_id))) => Ok(Some(ClaimedDispatch {
                        message_id,
                        turn_id,
                    })),
                    Some(_) => Err(AppStorageError::new(
                        "queued_message_link_incomplete",
                        "Queued message durable link is incomplete.",
                    )),
                }
            })
            .await
            .map_err(app_error)
    }

    pub(super) async fn publish_acceptance(
        &self,
        chat_id: &str,
        message_id: &str,
        turn_id: &str,
    ) -> Result<(), GatewayApplicationError> {
        let chat = chat_id.to_owned();
        let message = message_id.to_owned();
        let turn = turn_id.to_owned();
        let subscribers = self.subscribers.clone();
        let now = self.dependencies.identity_clock.now_iso();
        self.storage
            .execute(move |db| {
                let message_view = read_model::list_messages(db, &chat, 0.0, 200)?
                    .messages
                    .into_iter()
                    .find(|row| row.id == message)
                    .ok_or_else(|| {
                        AppStorageError::new(
                            "accepted_message_missing",
                            "Accepted message was not found.",
                        )
                    })?;
                let turn_view = read_model::list_turns(db, &chat, 0.0)?
                    .turns
                    .into_iter()
                    .find(|row| row.id == turn)
                    .ok_or_else(|| {
                        AppStorageError::new(
                            "accepted_turn_missing",
                            "Accepted Turn was not found.",
                        )
                    })?;
                events::append(
                    db,
                    &subscribers,
                    "message.created",
                    Some(&turn),
                    map(json!({"message":message_view}))?,
                    &now,
                )?;
                events::append(
                    db,
                    &subscribers,
                    "turn.state_changed",
                    Some(&turn),
                    map(json!({"turn":turn_view}))?,
                    &now,
                )?;
                Ok(())
            })
            .await
            .map_err(app_error)
    }

    pub(super) async fn finish_visual(
        &self,
        chat_id: &str,
        queued_id: &str,
        attachments: Value,
    ) -> Result<(), GatewayApplicationError> {
        let chat = chat_id.to_owned();
        let queued = queued_id.to_owned();
        let serialized = stringify(&attachments)?;
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        self.storage.execute(move|db|{
            db.execute("UPDATE session_queued_messages SET attachments_json=?1,updated_at=?2 WHERE id=?3 AND state='queued'",
                params![serialized,now,queued]).map_err(AppStorageError::sqlite)?;
            let payload=map(json!({"session_id":chat,"queued_message_id":queued,"action":"created"}))?;
            events::append(db,&subscribers,"session_queue.changed",None,payload,&now)?; Ok(())
        }).await.map_err(app_error)
    }

    pub(super) async fn fail_admission(
        &self,
        chat_id: &str,
        queued_id: &str,
        error: &GatewayApplicationError,
    ) -> Result<(), GatewayApplicationError> {
        let code = match error {
            GatewayApplicationError::Public { code, .. } => code.clone(),
            _ => "queued_message_admission_failed".to_owned(),
        };
        let chat = chat_id.to_owned();
        let queued = queued_id.to_owned();
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        self.storage.execute(move|db|{
            db.execute("UPDATE session_queued_messages SET state='failed',safe_error_code=?1,updated_at=?2 WHERE id=?3 AND state='queued'",params![code,now,queued]).map_err(AppStorageError::sqlite)?;
            let payload=map(json!({"session_id":chat,"queued_message_id":queued,"action":"failed","safe_error_code":code}))?;
            events::append(db,&subscribers,"session_queue.changed",None,payload,&now)?;Ok(())
        }).await.map_err(app_error)
    }

    pub(super) async fn claimed_client_message_id(
        &self,
        claim: &QueueClaim,
    ) -> Result<String, GatewayApplicationError> {
        let id = claim.queued_message_id.clone();
        let chat = claim.chat_id.clone();
        let fence = claim.claim_id.clone();
        self.storage.execute(move|db| db.query_row("SELECT client_message_id FROM session_queued_messages WHERE id=?1 AND chat_id=?2 AND state='dispatching' AND claim_id=?3",params![id,chat,fence],|row|row.get(0)).map_err(AppStorageError::sqlite)).await.map_err(app_error)
    }

    pub(super) async fn queued_result(
        &self,
        chat_id: &str,
        client_id: &str,
    ) -> Result<MessageSendResult, GatewayApplicationError> {
        let chat = chat_id.to_owned();
        let client = client_id.to_owned();
        let queued = self
            .storage
            .execute(move |db| queue_view::queued_message(db, &chat, &client))
            .await
            .map_err(app_error)?;
        let cursor = self
            .storage
            .execute({
                let chat = chat_id.to_owned();
                move |db| read_model::latest_message_cursor(db, &chat)
            })
            .await
            .map_err(app_error)?;
        Ok(MessageSendResult {
            accepted: None,
            queued,
            reply: None,
            replies: Vec::new(),
            turn: None,
            next_cursor: cursor,
        })
    }

    pub(super) async fn fail_dispatch(
        &self,
        claim: &QueueClaim,
        code: &str,
    ) -> Result<(), GatewayApplicationError> {
        let claim = claim.clone();
        let wake_chat = claim.chat_id.clone();
        let code = code.to_owned();
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        self.storage.execute(move|db|{
            let tx=db.transaction().map_err(AppStorageError::sqlite)?;
            let turn_id=tx.query_row("SELECT turn_id FROM session_queued_messages WHERE id=?1 AND state='dispatching' AND claim_id=?2",params![claim.queued_message_id,claim.claim_id],|row|row.get::<_,Option<String>>(0)).optional().map_err(AppStorageError::sqlite)?.flatten();
            let changed=tx.execute("UPDATE session_queued_messages SET state='failed',safe_error_code=?1,claim_id=NULL,claim_owner=NULL,claimed_at=NULL,lease_expires_at=NULL,updated_at=?2 WHERE id=?3 AND chat_id=?4 AND state='dispatching' AND claim_id=?5",params![code,now,claim.queued_message_id,claim.chat_id,claim.claim_id]).map_err(AppStorageError::sqlite)?;
            if changed!=1{return Err(AppStorageError::new("queued_message_claim_lost","Queued message claim was lost."))}
            if let Some(turn)=turn_id.as_deref(){tx.execute("UPDATE turns SET state='failed',safe_status_label='Failed',safe_error_code=?1,retryable=1,cancellable=0,updated_at=?2 WHERE id=?3",params![code,now,turn]).map_err(AppStorageError::sqlite)?;}
            let payload=map(json!({"session_id":claim.chat_id,"queued_message_id":claim.queued_message_id,"action":"failed","safe_error_code":code}))?;
            events::append(&tx,&subscribers,"session_queue.changed",turn_id.as_deref(),payload,&now)?;
            tx.commit().map_err(AppStorageError::sqlite)?;Ok(())
        }).await.map_err(app_error)?;
        if let Some(dispatcher) = &self.queue_dispatcher {
            dispatcher.wake_chat(wake_chat).await?;
        }
        Ok(())
    }
}

pub(super) struct ClaimedDispatch {
    pub message_id: String,
    pub turn_id: String,
}

pub(super) fn assert_scope(
    db: &Connection,
    chat_id: &str,
    expected: Option<&str>,
    sources: &Value,
) -> Result<(), AppStorageError> {
    let current = db
        .query_row(
            "SELECT project_id,archived FROM chats WHERE id=?1",
            [chat_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .ok_or_else(|| AppStorageError::new("session_not_found", "Session not found."))?;
    let relocating = db
        .query_row(
            "SELECT 1 FROM app_session_context_gate WHERE session_id=?1 AND owner_kind='relocate'",
            [chat_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .is_some();
    if relocating {
        return Err(AppStorageError::new(
            "session_relocating",
            "Session context is relocating.",
        ));
    }
    let source_mismatch = sources
        .as_array()
        .into_iter()
        .flatten()
        .any(|source| source.get("projectId").and_then(Value::as_str) != current.0.as_deref());
    if current.1 != 0
        || expected.is_some_and(|id| Some(id) != current.0.as_deref())
        || source_mismatch
    {
        return Err(AppStorageError::new(
            "project_source_scope_changed",
            "Project source scope changed.",
        ));
    }
    Ok(())
}

pub(super) fn accept_turn(
    db: &mut Connection,
    claim: &QueueClaim,
    turn_id: &str,
    message_id: &str,
    text: &str,
    controls_json: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    let tx = db.transaction().map_err(AppStorageError::sqlite)?;
    if !queue::fence(&tx, &claim.chat_id, turn_id, &claim.claim_id)? {
        // The queue is not linked yet; fence it by queue identity before creating public rows.
        let present=tx.query_row("SELECT 1 FROM session_queued_messages WHERE id=?1 AND chat_id=?2 AND state='dispatching' AND claim_id=?3",params![claim.queued_message_id,claim.chat_id,claim.claim_id],|_|Ok(())).optional().map_err(AppStorageError::sqlite)?.is_some();
        if !present {
            return Err(AppStorageError::new(
                "queued_message_claim_lost",
                "Queued message claim was lost.",
            ));
        }
    }
    tx.execute("INSERT INTO turns(id,chat_id,state,safe_status_label,retryable,cancellable,attempt,execution_controls_json,created_at,updated_at) VALUES(?1,?2,'accepted','Accepted',0,0,1,?3,?4,?4)",params![turn_id,claim.chat_id,controls_json,now]).map_err(AppStorageError::sqlite)?;
    let content: Option<String> = tx
        .query_row(
            "SELECT content_parts_json FROM session_queued_messages WHERE id=?1",
            [&claim.queued_message_id],
            |row| row.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    tx.execute("INSERT INTO messages(id,chat_id,turn_id,role,text,content_parts_json,status,created_at,updated_at,retryable) VALUES(?1,?2,?3,'user',?4,?5,'sent',?6,?6,0)",params![message_id,claim.chat_id,turn_id,text,content,now]).map_err(AppStorageError::sqlite)?;
    attach_queued_files(&tx, &claim.queued_message_id, message_id)?;
    tx.execute("UPDATE turns SET user_message_id=?1,state='thinking',safe_status_label='Thinking',cancellable=1,updated_at=?2 WHERE id=?3",params![message_id,now,turn_id]).map_err(AppStorageError::sqlite)?;
    if !queue::link_dispatch(&tx, claim, message_id, turn_id, now)? {
        return Err(AppStorageError::new(
            "queued_message_claim_lost",
            "Queued message claim was lost.",
        ));
    }
    tx.commit().map_err(AppStorageError::sqlite)
}

fn attach_queued_files(
    tx: &Transaction<'_>,
    queued_id: &str,
    message_id: &str,
) -> Result<(), AppStorageError> {
    let json: String = tx
        .query_row(
            "SELECT attachments_json FROM session_queued_messages WHERE id=?1",
            [queued_id],
            |row| row.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    for (position, value) in serde_json::from_str::<Vec<Value>>(&json)
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        if let Some(id) = value
            .as_str()
            .or_else(|| value.get("file_id").and_then(Value::as_str))
        {
            tx.execute("INSERT OR IGNORE INTO message_attachments(message_id,file_id,position) VALUES(?1,?2,?3)",params![message_id,id,position]).map_err(AppStorageError::sqlite)?;
            tx.execute(
                "UPDATE message_files SET message_id=?1 WHERE id=?2",
                params![message_id, id],
            )
            .map_err(AppStorageError::sqlite)?;
        }
    }
    Ok(())
}

pub(super) fn map(value: Value) -> Result<Map<String, Value>, AppStorageError> {
    value.as_object().cloned().ok_or_else(|| {
        AppStorageError::new(
            "app_event_payload_invalid",
            "Event payload must be an object.",
        )
    })
}
