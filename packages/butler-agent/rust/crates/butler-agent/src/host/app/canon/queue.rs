use super::*;
use butler_gateway::gateway::AppCanonOperation;

pub(super) async fn execute(
    storage: BtccStorage,
    ledger: progress::ProjectReader,
    op: AppCanonOperation,
    ctx: store::Context,
) -> Result<Value, GatewayApplicationError> {
    let result = match op {
        AppCanonOperation::BoundSessions => storage
            .canon_read(store::queue::bound_sessions)
            .await
            .map_err(error)?,
        AppCanonOperation::Queue { action, .. } if action == "running" => {
            return storage
                .canon_read(store::queue::running)
                .await
                .map_err(error);
        }
        AppCanonOperation::Queue { action, input, .. } if action == "owner" => {
            return storage
                .canon_read(move |db| {
                    store::queue::owner(
                        db,
                        input["epic_id"]
                            .as_str()
                            .ok_or(store::Error::Invalid("epic_id"))?,
                    )
                })
                .await
                .map_err(error);
        }
        AppCanonOperation::Queue {
            session_id,
            action,
            input: _,
        } if action == "get" => storage
            .canon_read(move |db| {
                store::queue::view(db, &session_id, &store::runtime::ProjectViews::new())
            })
            .await
            .map_err(error)?,
        operation => storage
            .canon_write(move |tx| write(tx, &ctx, operation))
            .await
            .map_err(error)?,
    };
    progress::enrich(&storage, &ledger, result).await
}

fn write(
    tx: &store::Transaction<'_>,
    ctx: &store::Context,
    operation: AppCanonOperation,
) -> store::Result<Value> {
    match operation {
        AppCanonOperation::Queue {
            session_id,
            action,
            input,
        } => match action.as_str() {
            "request" => store::queue::request(tx, ctx, &session_id, &input),
            "edit" => store::queue::edit(tx, ctx, &session_id, &input),
            "hold" => store::queue::decide_hold(
                tx,
                ctx,
                &session_id,
                field(&input, "epic_id")?,
                field(&input, "decision")?,
            ),
            "take" => store::queue::take_here(
                tx,
                ctx,
                &session_id,
                field(&input, "epic_id")?,
                field(&input, "source_session_id")?,
                input["source_step_op_id"].as_str(),
            ),
            _ => Err(store::Error::Invalid("queue operation")),
        },
        AppCanonOperation::StepTurnEnded { op_id, outcome } => {
            store::queue::engine::turn_ended(tx, ctx, &op_id, &outcome)
        }
        AppCanonOperation::SessionDeleted {
            session_hint,
            op_id,
        } => store::queue::session_deleted(tx, ctx, &session_hint, &op_id),
        _ => Err(store::Error::Invalid("queue operation")),
    }
}
fn field<'a>(input: &'a Value, name: &str) -> store::Result<&'a str> {
    input[name]
        .as_str()
        .ok_or(store::Error::Invalid("missing queue field"))
}
