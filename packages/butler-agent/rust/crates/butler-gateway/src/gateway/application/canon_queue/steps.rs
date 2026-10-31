use super::*;
use crate::gateway::{GatewayApplication, MessageSendRequest, SendMessageCommand};

pub(super) async fn apply(
    app: &AppApplication,
    op: &str,
    payload: Value,
) -> Result<(), GatewayApplicationError> {
    let owner = field(&payload, "session_id")?;
    let chat = app.owner_chat(owner).await?;
    let id = format!("canon-step-{}", butler_turn::btcc::digest_identity(op));
    let message = super::super::admission_identity::canonical_client_id(&id);
    let now = app.dependencies.identity_clock.now_iso();
    let source = op.to_owned();
    let text = format!("canon:epic/{}", field(&payload, "epic_id")?);
    let data = payload.clone();
    let target = chat.clone();
    let key = id.clone();
    let content = text.clone();
    app.storage.execute(move|db| {
        super::super::initiated::enqueue_canon(db,(&key,&target),&source,"canon_step",&content,&data,&now)?;
        db.execute("UPDATE app_initiated_messages SET message_id=?1,bypass_quiet_hours=1 WHERE id=?2 AND message_id IS NULL",params![message,key]).map_err(AppStorageError::sqlite)?;
        Ok(())
    }).await.map_err(app_error)?;
    deliver(app, id).await
}
pub(in crate::gateway::application) async fn deliver(
    app: &AppApplication,
    id: String,
) -> Result<(), GatewayApplicationError> {
    let key = id.clone();
    let (chat, text, state, op, raw) = app
        .storage
        .read(move |db| {
            db.query_row(
                "SELECT chat_id,text,state,source_key,payload_json FROM app_initiated_messages WHERE id=?1",
                [key],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                },
            )
            .map_err(AppStorageError::sqlite)
        })
        .await
        .map_err(app_error)?;
    let mut guards = ReplayLocks::new(app);
    guards.acquire(format!("canon-delivery:{chat}")).await;
    if state != "held" {
        return Ok(());
    }
    let payload: Value =
        serde_json::from_str(&raw).map_err(GatewayApplicationError::internal_from)?;
    if !owns_step(app, &op, &payload).await? {
        app.storage.execute(move |db| {
            db.execute("UPDATE app_initiated_messages SET state='withdrawn' WHERE id=?1 AND state='held'", [id]).map_err(AppStorageError::sqlite)?;
            Ok(())
        }).await.map_err(app_error)?;
        return Ok(());
    }
    let Some(_posting) = super::super::initiated::posting::Reservation::claim(app, id.clone())
        .await
        .map_err(app_error)?
    else {
        return Ok(());
    };
    #[cfg(feature = "e2e-fixtures")]
    super::super::canon::hold(app, "canon_step_admission").await?;
    app.send_message(SendMessageCommand {
        chat_id: chat,
        request: MessageSendRequest {
            text: Some(json!(text)),
            client_message_id: Some(json!(id)),
            ..Default::default()
        },
    })
    .await?;
    let now = app.dependencies.identity_clock.now_iso();
    app.storage.execute(move|db| {
        db.execute("UPDATE app_initiated_messages SET state='posted',posting=0,posted_at=?2 WHERE id=?1",params![id,now]).map_err(AppStorageError::sqlite)?;
        Ok(())
    }).await.map_err(app_error)
}
async fn owns_step(
    app: &AppApplication,
    op: &str,
    payload: &Value,
) -> Result<bool, GatewayApplicationError> {
    let owner = field(payload, "session_id")?;
    let current = app
        .dependencies
        .canon
        .canon_operation(AppCanonOperation::Queue {
            session_id: owner.clone(),
            action: "owner".into(),
            input: json!({"epic_id":payload["epic_id"]}),
        })
        .await?;
    Ok(current["session_id"] == owner && current["step_op_id"] == op)
}

/// A durable terminal receipt. Startup and projection call the same operation.
pub(in crate::gateway::application) async fn turn_ended(
    storage: &super::super::storage::AppStorage,
    port: &Arc<dyn AppCanonPort>,
    turn: String,
) -> Result<(), GatewayApplicationError> {
    let row=storage.read(move|db|db.query_row("SELECT i.source_key,t.state,t.safe_error_code FROM turns t JOIN app_initiated_messages i ON i.message_id=t.user_message_id WHERE t.id=?1 AND i.kind='canon_step' AND t.state IN ('delivered','failed','cancelled','runtime_fault')",[turn],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?))).optional().map_err(AppStorageError::sqlite)).await.map_err(app_error)?;
    if let Some((op, state, code)) = row {
        let outcome = if code.as_deref() == Some("turn_interrupted") {
            "turn_interrupted".into()
        } else if state == "runtime_fault" {
            "failed".into()
        } else {
            state
        };
        port.canon_operation(AppCanonOperation::StepTurnEnded { op_id: op, outcome })
            .await?;
    }
    Ok(())
}

/// Admission can terminate a step before a public turn exists.
pub(in crate::gateway::application) async fn delivery_failed(
    app: &AppApplication,
    id: String,
    queued: bool,
) -> Result<(), GatewayApplicationError> {
    let op = app.storage.read(move |db| {
        let sql = if queued {
            "SELECT i.source_key FROM session_queued_messages q JOIN app_initiated_messages i ON i.chat_id=q.chat_id AND i.message_id=q.client_message_id WHERE q.id=?1 AND q.state='failed' AND i.kind='canon_step'"
        } else {
            "SELECT source_key FROM app_initiated_messages WHERE id=?1 AND state='failed' AND kind='canon_step'"
        };
        db.query_row(sql, [id], |r|r.get::<_,String>(0)).optional().map_err(AppStorageError::sqlite)
    }).await.map_err(app_error)?;
    if let Some(op_id) = op {
        app.dependencies
            .canon
            .canon_operation(AppCanonOperation::StepTurnEnded {
                op_id,
                outcome: "failed".into(),
            })
            .await?;
    }
    Ok(())
}
