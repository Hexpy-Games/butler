use super::*;
use butler_gateway::gateway::{APP_PERSON_ID, AppCanonOperation};

pub(super) fn execute(
    storage: BtccStorage,
    ledger: progress::ProjectReader,
    operation: AppCanonOperation,
) -> ApplicationFuture<Value> {
    Box::pin(async move {
        let ctx = store::Context {
            now: chrono::Utc::now().timestamp_millis(),
            actor: json!({"person": APP_PERSON_ID, "via":"app"}),
        };
        if matches!(
            operation,
            AppCanonOperation::Queue { .. }
                | AppCanonOperation::StepTurnEnded { .. }
                | AppCanonOperation::SessionDeleted { .. }
                | AppCanonOperation::BoundSessions
        ) {
            return super::queue::execute(storage, ledger, operation, ctx).await;
        }
        let result = match operation {
            AppCanonOperation::Link {
                work_id,
                session_id,
                new_session_id,
            } => storage
                .canon_write(move |tx| {
                    store::api::canon_conversation::link(
                        tx,
                        &ctx,
                        &work_id,
                        session_id.as_deref(),
                        &new_session_id,
                    )
                })
                .await
                .map_err(error),
            AppCanonOperation::PendingQueue => storage
                .canon_read(move |db| Ok(json!(store::queue::pending(db)?)))
                .await
                .map_err(error),
            AppCanonOperation::Pending { after } => storage
                .canon_read(move |db| Ok(json!(store::pending_intents(db, &after, 128)?)))
                .await
                .map_err(error),
            AppCanonOperation::Applied { op_id, revision } => storage
                .canon_write(move |tx| {
                    store::api::canon_conversation::applied(tx, &ctx, &op_id, revision)
                })
                .await
                .map_err(error),
            _ => Err(GatewayApplicationError::internal()),
        }?;
        progress::enrich(&storage, &ledger, result).await
    })
}
