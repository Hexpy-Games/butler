//! Boundary staging and delivery keep the existing claim-fenced projection.
use super::super::storage::AppStorageError;
use super::*;

pub(super) fn action_id(event: &TranscriptEvent) -> Option<String> {
    event
        .payload
        .get("actionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}
pub(super) async fn stage_event(
    context: &ProjectionContext,
    chat_id: &str,
    event: TranscriptEvent,
    action: String,
    cursor: Checkpoint,
) -> Result<bool, GatewayApplicationError> {
    let claim = staging::claim_id_from_event(&event);
    let chat = chat_id.to_owned();
    let now = context.dependencies.identity_clock.now_iso();
    context
        .storage
        .execute(move |db| {
            let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
            if !staging::projected(&tx, &action)? {
                staging::stage(&tx, &action, &chat, &event, claim.as_deref(), &now)?;
            }
            checkpoint::save(&tx, &cursor, &now)?;
            tx.commit().map_err(AppStorageError::sqlite)
        })
        .await
        .map_err(app_error)?;
    Ok(true)
}
pub(super) async fn discard(
    context: &ProjectionContext,
    action: String,
    cursor: Checkpoint,
) -> Result<bool, GatewayApplicationError> {
    let now = context.dependencies.identity_clock.now_iso();
    context
        .storage
        .execute(move |db| {
            let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
            staging::delete(&tx, &action)?;
            checkpoint::save(&tx, &cursor, &now)?;
            tx.commit().map_err(AppStorageError::sqlite)
        })
        .await
        .map_err(app_error)
        .map(|()| true)
}
pub(super) async fn non_final(
    context: &ProjectionContext,
    chat: String,
    outbound: TranscriptEvent,
    action: String,
    cursor: Checkpoint,
) -> Result<non_final::ProjectionOutcome, GatewayApplicationError> {
    let non_final_event = outbound.clone();
    let non_final_action = action;
    let non_final_chat = chat.clone();
    let non_final_checkpoint = cursor;
    let non_final_now = context.dependencies.identity_clock.now_iso();
    let non_final_ids = non_final::ProjectionIds {
        event_id: format!(
            "turn-event-{}",
            context.dependencies.identity_clock.new_uuid()
        ),
        message_id: format!("message-{}", context.dependencies.identity_clock.new_uuid()),
    };
    let materialization_data = context.butler_data.clone();
    let materialization_chat = chat.clone();
    let materialization_event = outbound.clone();
    let worker_materialization = context
        .storage
        .inspect(move |db| {
            final_candidate::worker_materialization(
                db,
                &materialization_data,
                &materialization_chat,
                &materialization_event,
            )
        })
        .await
        .map_err(app_error)?;
    let worker_files = match worker_materialization {
        Some(request) => {
            context
                .dependencies
                .artifact_materializer
                .materialize(request)
                .await?
        }
        None => Vec::new(),
    };
    let non_final_subscribers = context.subscribers.clone();
    context
        .storage
        .execute(move |db| {
            non_final::apply(
                db,
                non_final::ApplyInput {
                    chat_id: &non_final_chat,
                    action_id: &non_final_action,
                    outbound: &non_final_event,
                    cursor: &non_final_checkpoint,
                    now: &non_final_now,
                    subscribers: &non_final_subscribers,
                    ids: non_final_ids,
                    worker_files,
                },
            )
        })
        .await
        .map_err(app_error)
}
pub(super) async fn terminal(
    context: &ProjectionContext,
    stored_chat: String,
    outbound: TranscriptEvent,
    action: String,
    checkpoint: Checkpoint,
) -> Result<bool, GatewayApplicationError> {
    let terminal_root = context.butler_data.clone();
    let terminal_event = outbound.clone();
    let disposition = tokio::task::spawn_blocking(move || {
        terminal_records::disposition(&terminal_root, &terminal_event)
    })
    .await
    .map_err(GatewayApplicationError::internal_from)?;
    match disposition {
        terminal_records::Disposition::Accept => {}
        terminal_records::Disposition::Defer => {
            let now = context.dependencies.identity_clock.now_iso();
            return context
                .storage
                .execute(move |db| {
                    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
                    staging::defer(&tx, &action, &now)?;
                    checkpoint::save(&tx, &checkpoint, &now)?;
                    tx.commit().map_err(AppStorageError::sqlite)
                })
                .await
                .map_err(app_error)
                .map(|()| true);
        }
        terminal_records::Disposition::Reject => {
            let now = context.dependencies.identity_clock.now_iso();
            return context
                .storage
                .execute(move |db| {
                    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
                    staging::delete(&tx, &action)?;
                    staging::mark(&tx, &action, &outbound.event_id, &stored_chat, &now)?;
                    checkpoint::save(&tx, &checkpoint, &now)?;
                    tx.commit().map_err(AppStorageError::sqlite)
                })
                .await
                .map_err(app_error)
                .map(|()| true);
        }
    }
    project_final(context, stored_chat, outbound, Some(checkpoint)).await
}
