use super::*;

/// Release the source identity atomically with the move. Both delivery locks
/// stay held through Stop. The move records cancellation durably and gates the
/// target until a terminal receipt clears it; lock release also wakes replay.
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
    let mut guards = ReplayLocks::new(app);
    if let Some(op) = owner["step_op_id"].as_str() {
        guards.acquire(op.to_owned()).await;
    }
    let source_chat = app.owner_chat(field(&owner, "session_id")?).await?;
    let mut chats = [source_chat, chat.to_owned()];
    chats.sort();
    for chat in chats {
        guards.acquire(format!("canon-delivery:{chat}")).await;
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
    if let Some(op) = owner["step_op_id"].as_str()
        && let Err(error) = stop_source(app, op.to_owned(), true).await
    {
        tracing::warn!(%error, "Canon move committed; source Stop deferred to recovery");
    }
    drop(guards);
    Ok(result)
}

async fn stop_source(
    app: &AppApplication,
    source: String,
    wait: bool,
) -> Result<(), GatewayApplicationError> {
    let key = source.clone();
    let row=app.storage.read(move|db|db.query_row("SELECT i.id,t.id,q.id,q.state FROM app_initiated_messages i LEFT JOIN turns t ON t.user_message_id=i.message_id LEFT JOIN session_queued_messages q ON q.chat_id=i.chat_id AND q.client_message_id=i.message_id WHERE i.source_key=?1",[key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?))).optional().map_err(AppStorageError::sqlite)).await.map_err(app_error)?;
    if let Some((id, turn, queued, state)) = row {
        if state.as_deref() == Some("dispatching") && turn.is_none() {
            return Ok(());
        }
        if matches!(state.as_deref(), Some("queued" | "failed")) {
            if let Some(queued) = queued {
                app.delete_session_queue_owned(queued).await?;
            }
        } else if let Some(turn) = turn {
            if wait {
                stop(app, turn.clone()).await?;
            } else {
                let id = turn.clone();
                let active = app.storage.read(move |db| db.query_row("SELECT state NOT IN ('delivered','cancelled','failed','runtime_fault') FROM turns WHERE id=?1", [id], |r| r.get::<_, bool>(0)).map_err(AppStorageError::sqlite)).await.map_err(app_error)?;
                if active {
                    app.cancel_turn_owned(turn).await?;
                    return Ok(());
                }
            }
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
    app.dependencies
        .canon
        .canon_operation(AppCanonOperation::StepTurnEnded {
            op_id: source,
            outcome: "cancelled".into(),
            turn_id: None,
        })
        .await?;
    Ok(())
}

/// Native turn completion publishes changes on the same watch as canon writes.
/// Retry unresolved cancellations without waiting on an in-flight move.
/// Skipped identities remain durable; their lock holder wakes us on release.
pub(super) async fn reconcile(app: &AppApplication) -> Result<(), GatewayApplicationError> {
    let pending = app
        .dependencies
        .canon
        .canon_operation(AppCanonOperation::Queue {
            session_id: String::new(),
            action: "cancellations".into(),
            input: json!({}),
        })
        .await?;
    for row in pending.as_array().into_iter().flatten() {
        if let Err(error) = reconcile_one(app, row).await {
            tracing::warn!(op_id = %row["op_id"], %error, "Canon source cancellation remains pending");
        }
    }
    Ok(())
}

async fn reconcile_one(app: &AppApplication, row: &Value) -> Result<(), GatewayApplicationError> {
    let op = field(row, "op_id")?;
    let Some(_projection) = app.canon_projection_locks.try_acquire(op.clone()) else {
        return Ok(());
    };
    let owner = field(row, "source_session_id")?;
    let chat = app
        .storage
        .read(move |db| sessions::identity::resolve_owner(db, &owner))
        .await
        .map_err(app_error)?;
    let Some(chat) = chat else {
        app.dependencies
            .canon
            .canon_operation(AppCanonOperation::StepTurnEnded {
                op_id: op,
                outcome: "cancelled".into(),
                turn_id: None,
            })
            .await?;
        return Ok(());
    };
    let Some(_delivery) = app
        .canon_projection_locks
        .try_acquire(format!("canon-delivery:{chat}"))
    else {
        return Ok(());
    };
    stop_source(app, op, false).await
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
