use super::*;

/// Startup only. Enumerate indexed bound owners, then indexed App identities.
pub(in crate::gateway::application) async fn reconcile(
    app: &AppApplication,
) -> Result<(), GatewayApplicationError> {
    app.dependencies.executor_readiness.wait_ready().await?;
    replay_deletes(app).await?;
    let sessions = app
        .dependencies
        .canon
        .canon_operation(AppCanonOperation::BoundSessions)
        .await?;
    for session in sessions
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let owner = session.to_owned();
        let chat = app
            .storage
            .read(move |db| sessions::identity::resolve_owner(db, &owner))
            .await
            .map_err(app_error)?;
        if chat.is_none() {
            app.dependencies
                .canon
                .canon_operation(AppCanonOperation::SessionDeleted {
                    session_hint: session.to_owned(),
                    op_id: format!("session-reconcile:{session}"),
                })
                .await?;
        }
    }
    taking::reconcile(app).await?;
    let running = app
        .dependencies
        .canon
        .canon_operation(AppCanonOperation::Queue {
            session_id: String::new(),
            action: "running".into(),
            input: json!({}),
        })
        .await?;
    for item in running.as_array().into_iter().flatten() {
        let op = field(item, "step_op_id")?;
        let turn = app.storage.read(move |db| db.query_row(
            "SELECT t.id FROM app_initiated_messages i JOIN turns t ON t.user_message_id=i.message_id WHERE i.source_key=?1 AND i.kind='canon_step'",
            [op], |r|r.get::<_,String>(0)).optional().map_err(AppStorageError::sqlite)).await.map_err(app_error)?;
        if let Some(turn) = turn {
            steps::turn_ended(&app.storage, &app.dependencies.canon, turn).await?;
        }
    }
    Ok(())
}

/// The App delete and this receipt share a transaction, so failed canon writes
/// remain recoverable on the next real change, even across process loss.
pub(in crate::gateway::application) async fn complete_delete(
    app: &AppApplication,
    op: String,
) -> Result<(), GatewayApplicationError> {
    let _guard = app.canon_projection_locks.acquire(op.clone()).await;
    let key = op.clone();
    let hint = app
        .storage
        .read(move |db| {
            db.query_row(
                "SELECT session_hint FROM app_canon_session_deletes WHERE op_id=?1",
                [key],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(AppStorageError::sqlite)
        })
        .await
        .map_err(app_error)?;
    let Some(session_hint) = hint else {
        return Ok(());
    };
    app.dependencies
        .canon
        .canon_operation(AppCanonOperation::SessionDeleted {
            session_hint,
            op_id: op.clone(),
        })
        .await?;
    app.storage
        .execute(move |db| {
            db.execute("DELETE FROM app_canon_session_deletes WHERE op_id=?1", [op])
                .map_err(AppStorageError::sqlite)?;
            Ok(())
        })
        .await
        .map_err(app_error)
}

pub(super) async fn replay_deletes(app: &AppApplication) -> Result<(), GatewayApplicationError> {
    let mut after = String::new();
    loop {
        let cursor = after.clone();
        let ops = app.storage.read(move |db| {
            db.prepare("SELECT op_id FROM app_canon_session_deletes WHERE op_id>?1 ORDER BY op_id LIMIT 128")
                .map_err(AppStorageError::sqlite)?.query_map([cursor], |r| r.get::<_,String>(0))
                .map_err(AppStorageError::sqlite)?.collect::<Result<Vec<_>,_>>()
                .map_err(AppStorageError::sqlite)
        }).await.map_err(app_error)?;
        if ops.is_empty() {
            return Ok(());
        }
        for op in ops {
            after = op.clone();
            if let Err(error) = complete_delete(app, op).await {
                tracing::warn!(op_id = %after, %error, "Canon session delete remains pending");
            }
        }
    }
}
