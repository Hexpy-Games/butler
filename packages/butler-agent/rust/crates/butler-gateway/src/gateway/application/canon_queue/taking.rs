use super::*;

/// Release the source identity atomically with the move. Both delivery locks
/// stay held until Stop confirms cancellation, so the target cannot start early.
pub(super) async fn execute(
    app: &AppApplication,
    chat: &str,
    session: &str,
    mut input: Value,
) -> Result<Value, GatewayApplicationError> {
    let epic = field(&input, "epic_id")?;
    let owner = app
        .dependencies
        .canon
        .canon_operation(AppCanonOperation::Queue {
            session_id: session.to_owned(),
            action: "owner".into(),
            input: json!({"epic_id":epic}),
        })
        .await?;
    if owner.is_null() || owner["session_id"] == session {
        return Err(public(
            409,
            "conflict",
            "Epic is no longer in another conversation.",
        ));
    }
    let projection = if let Some(op) = owner["step_op_id"].as_str() {
        Some(app.canon_projection_locks.acquire(op.to_owned()).await)
    } else {
        None
    };
    let source_chat = app.owner_chat(field(&owner, "session_id")?).await?;
    let mut chats = [source_chat, chat.to_owned()];
    chats.sort();
    let mut deliveries = Vec::new();
    for chat in chats {
        deliveries.push(
            app.canon_projection_locks
                .acquire(format!("canon-delivery:{chat}"))
                .await,
        );
    }
    input["source_session_id"] = owner["session_id"].clone();
    input["source_step_op_id"] = owner["step_op_id"].clone();
    let result = app
        .dependencies
        .canon
        .canon_operation(AppCanonOperation::Queue {
            session_id: session.to_owned(),
            action: "take".into(),
            input,
        })
        .await?;
    if let Some(op) = owner["step_op_id"].as_str() {
        stop_source(app, op.to_owned()).await?;
    }
    drop((projection, deliveries));
    Ok(result)
}

async fn stop_source(app: &AppApplication, source: String) -> Result<(), GatewayApplicationError> {
    let row=app.storage.read(move|db|db.query_row("SELECT i.id,t.id,q.id,q.state FROM app_initiated_messages i LEFT JOIN turns t ON t.user_message_id=i.message_id LEFT JOIN session_queued_messages q ON q.chat_id=i.chat_id AND q.client_message_id=i.message_id WHERE i.source_key=?1",[source],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?))).optional().map_err(AppStorageError::sqlite)).await.map_err(app_error)?;
    if let Some((id, turn, queued, state)) = row {
        if matches!(state.as_deref(), Some("queued" | "failed")) {
            if let Some(queued) = queued {
                app.delete_session_queue_owned(queued).await?;
            }
        } else if let Some(turn) = turn {
            stop(app, turn).await?;
        }
        app.storage
            .execute(move |db| {
                db.execute(
                    "UPDATE app_initiated_messages SET state='withdrawn' WHERE id=?1",
                    [id],
                )
                .map_err(AppStorageError::sqlite)?;
                Ok(())
            })
            .await
            .map_err(app_error)?;
    }
    Ok(())
}

async fn stop(app: &AppApplication, turn: String) -> Result<(), GatewayApplicationError> {
    let changed = Arc::new(tokio::sync::Notify::new());
    let signal = changed.clone();
    let _subscription = app
        .subscribers
        .subscribe(Arc::new(move |_| signal.notify_one()));
    let state = turn.clone();
    let active=app.storage.read(move|db|db.query_row("SELECT state NOT IN ('delivered','cancelled','failed','runtime_fault') FROM turns WHERE id=?1",[state],|r|r.get::<_,bool>(0)).map_err(AppStorageError::sqlite)).await.map_err(app_error)?;
    if !active {
        return Ok(());
    }
    app.cancel_turn_owned(turn.clone()).await?;
    loop {
        let notified = changed.notified();
        let id = turn.clone();
        let terminal=app.storage.read(move|db|db.query_row("SELECT state IN ('delivered','cancelled','failed','runtime_fault') FROM turns WHERE id=?1",[id],|r|r.get::<_,bool>(0)).map_err(AppStorageError::sqlite)).await.map_err(app_error)?;
        if terminal {
            return Ok(());
        }
        tokio::select! {()=app.dependencies.service_shutdown.cancelled()=>return Err(GatewayApplicationError::internal()),()=notified=>{}}
    }
}
