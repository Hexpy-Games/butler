//! Replays terminal events staged while their terminal records were not yet
//! decidable: accept projects the final result, reject retires the staging row.

use super::{ProjectionContext, project_final, staging, terminal_records};
use crate::gateway::application::{GatewayApplicationError, app_error};

pub(super) async fn sync_deferred_once(
    context: &ProjectionContext,
) -> Result<bool, GatewayApplicationError> {
    let mut after = String::new();
    while sync_deferred_step(context, &mut after).await? {}
    Ok(false)
}

pub(super) async fn sync_deferred_step(
    context: &ProjectionContext,
    after: &mut String,
) -> Result<bool, GatewayApplicationError> {
    let cursor = after.clone();
    let row = context
        .storage
        .execute(move |db| staging::deferred_batch(db, &cursor, 1))
        .await
        .map_err(app_error)?
        .into_iter()
        .next();
    let Some((action, chat, event)) = row else {
        return Ok(false);
    };
    *after = action.clone();
    let root = context.butler_data.clone();
    let check = event.clone();
    let disposition =
        tokio::task::spawn_blocking(move || terminal_records::disposition(&root, &check))
            .await
            .map_err(|_| GatewayApplicationError::Internal)?;
    match disposition {
        terminal_records::Disposition::Defer => {}
        terminal_records::Disposition::Accept => {
            let _ = project_final(context, chat, event, None).await?;
        }
        terminal_records::Disposition::Reject => {
            let now = context.dependencies.identity_clock.now_iso();
            context
                .storage
                .execute(move |db| {
                    let tx = db
                        .transaction()
                        .map_err(super::super::storage::AppStorageError::sqlite)?;
                    staging::delete(&tx, &action)?;
                    staging::mark(&tx, &action, &event.event_id, &chat, &now)?;
                    tx.commit()
                        .map_err(super::super::storage::AppStorageError::sqlite)
                })
                .await
                .map_err(app_error)?;
        }
    }
    Ok(true)
}
