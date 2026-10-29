//! Authenticated queue acts, runtime identity resolution and intent replay.
mod delete;
mod holds;
mod locks;
pub(in crate::gateway::application) mod steps;
mod taking;
use super::*;
pub(super) use delete::{complete_delete, reconcile};
use locks::ReplayLocks;
use rusqlite::{OptionalExtension, params};
use serde_json::json;
pub(in crate::gateway::application) use steps::turn_ended;

pub(super) async fn execute(
    app: &AppApplication,
    action: &str,
    input: Value,
) -> Result<Value, GatewayApplicationError> {
    let chat = field(&input, "session_id")?;
    let session = app.runtime_hint(&chat).await?;
    let action = match action {
        "queue_get" => "get",
        "queue_edit" => "edit",
        "queue_hold" => "hold",
        "queue_take" => "take",
        _ => "request",
    };
    let args = arguments(app, &chat, &input).await?;
    if action != "get" {
        validate(app, &chat, &args).await?;
    }
    let _take_guard = if action == "take" {
        Some(
            app.canon_projection_locks
                .acquire(format!("canon-take:{}", field(&args, "epic_id")?))
                .await,
        )
    } else {
        None
    };
    let result = if action == "take" {
        taking::execute(app, &chat, &session, args).await?
    } else {
        app.dependencies
            .canon
            .canon_operation(AppCanonOperation::Queue {
                session_id: session,
                action: action.into(),
                input: args,
            })
            .await?
    };
    let mut result = result;
    app.storage
        .read(move |db| {
            canon::public_sessions(db, &mut result)?;
            Ok(result)
        })
        .await
        .map_err(app_error)
}
async fn validate(
    app: &AppApplication,
    chat: &str,
    args: &Value,
) -> Result<(), GatewayApplicationError> {
    let id = chat.to_owned();
    let readonly = app
        .storage
        .read(move |db| {
            settings::conversation_access_mode(db, &id)
                .map(|a| settings::access_mode_name(&a) == "read_only")
        })
        .await
        .map_err(app_error)?;
    if readonly {
        return Err(public(
            403,
            "read_only",
            "This conversation is read-only. Change its permission level to queue epics.",
        ));
    }
    let resource = if args["plan_id"].is_string() {
        AppCanonResource::Plan
    } else {
        AppCanonResource::Epic
    };
    for id in [
        args["plan_id"]
            .as_str()
            .or_else(|| args["epic_id"].as_str()),
        args["target_epic_id"].as_str(),
    ]
    .into_iter()
    .flatten()
    {
        canon::execute(
            app,
            AppCanonRequest {
                resource,
                id: id.to_owned(),
                input: None,
                delegate: None,
            },
        )
        .await?;
    }
    Ok(())
}
pub(super) async fn apply(
    app: &AppApplication,
    intent: Value,
) -> Result<(), GatewayApplicationError> {
    let op = field(&intent, "op_id")?;
    let mut guards = ReplayLocks::new(app);
    guards.acquire(op.clone()).await;
    let raw = field(&intent, "payload_json")?;
    let payload: Value =
        serde_json::from_str(&raw).map_err(GatewayApplicationError::internal_from)?;
    match intent["kind"].as_str() {
        Some("canon_step") => steps::apply(app, &op, payload).await?,
        Some("canon_hold" | "canon_take_here") => {
            holds::apply(app, &op, field(&intent, "kind")?, payload).await?;
        }
        _ => return Ok(()),
    }
    app.dependencies
        .canon
        .canon_operation(AppCanonOperation::Applied {
            op_id: op,
            revision: intent["revision"]
                .as_i64()
                .ok_or_else(GatewayApplicationError::internal)?,
        })
        .await?;
    Ok(())
}

fn field(input: &Value, key: &str) -> Result<String, GatewayApplicationError> {
    input[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| public(400, "invalid_arguments", &format!("{key} required")))
}

pub(super) async fn replay(app: &AppApplication) -> Result<(), GatewayApplicationError> {
    delete::replay_deletes(app).await?;
    taking::reconcile(app).await?;
    let mut after = 0;
    loop {
        let pending = app
            .dependencies
            .canon
            .canon_operation(AppCanonOperation::PendingQueue { after })
            .await?;
        let pending = pending
            .as_array()
            .ok_or_else(GatewayApplicationError::internal)?;
        if pending.is_empty() {
            return Ok(());
        }
        for intent in pending {
            after = intent["replay_cursor"]
                .as_i64()
                .ok_or_else(GatewayApplicationError::internal)?;
            if let Err(error) = apply(app, intent.clone()).await {
                tracing::error!(op_id = %intent["op_id"], %error, "Canon queue intent failed");
            }
        }
    }
}

async fn arguments(
    app: &AppApplication,
    chat: &str,
    input: &Value,
) -> Result<Value, GatewayApplicationError> {
    let mut args = input
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| input.clone());
    if let Some(turn) = input["turn_id"].as_str() {
        let turn = turn.to_owned();
        let chat = chat.to_owned();
        let message = app
            .storage
            .read(move |db| {
                db.query_row(
                    "SELECT user_message_id FROM turns WHERE id=?1 AND chat_id=?2",
                    params![turn, chat],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        args["origin_message_id"] = json!(message);
    }
    Ok(args)
}
