use super::*;

/// Startup only. Enumerate indexed bound owners, then indexed App identities.
pub(in crate::gateway::application) async fn reconcile(
    app: &AppApplication,
) -> Result<(), GatewayApplicationError> {
    app.dependencies.executor_readiness.wait_ready().await?;
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
    let turns=app.storage.read(|db| {
        let mut stmt=db.prepare("SELECT t.id FROM app_initiated_messages i JOIN turns t ON t.user_message_id=i.message_id WHERE i.kind='canon_step'").map_err(AppStorageError::sqlite)?;
        stmt.query_map([],|r|r.get::<_,String>(0)).map_err(AppStorageError::sqlite)?.collect::<Result<Vec<_>,_>>().map_err(AppStorageError::sqlite)
    }).await.map_err(app_error)?;
    for turn in turns {
        steps::turn_ended(&app.storage, &app.dependencies.canon, turn).await?;
    }
    Ok(())
}
