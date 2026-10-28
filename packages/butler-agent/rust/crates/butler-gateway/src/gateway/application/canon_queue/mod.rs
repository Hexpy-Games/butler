//! Authenticated queue acts, runtime identity resolution and intent replay.
mod delete;
mod holds;
pub(in crate::gateway::application) mod steps;
use super::*;
pub(super) use delete::reconcile;
use rusqlite::{OptionalExtension, params};
use serde_json::json;
pub(in crate::gateway::application) use steps::turn_ended;

pub(super) async fn execute(
    app: &AppApplication,
    action: &str,
    mut input: Value,
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
    input = args;
    let _source_guards = if action == "take" {
        let (guards, source) = take_stop(app, &session, field(&input, "epic_id")?).await?;
        input["source_session_id"] = source["session_id"].clone();
        input["source_step_op_id"] = source["step_op_id"].clone();
        guards
    } else {
        Vec::new()
    };
    let result = app
        .dependencies
        .canon
        .canon_operation(AppCanonOperation::Queue {
            session_id: session,
            action: action.into(),
            input,
        })
        .await?;
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
    let _guard = app.canon_projection_locks.acquire(op.clone()).await;
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
async fn take_stop(
    app: &AppApplication,
    session: &str,
    epic: String,
) -> Result<(Vec<tokio::sync::OwnedMutexGuard<()>>, Value), GatewayApplicationError> {
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
    let Some(op) = owner["step_op_id"].as_str() else {
        return Ok((Vec::new(), owner));
    };
    let projection = app.canon_projection_locks.acquire(op.to_owned()).await;
    let chat = app.owner_chat(field(&owner, "session_id")?).await?;
    let delivery = app
        .canon_projection_locks
        .acquire(format!("canon-delivery:{chat}"))
        .await;
    let source = op.to_owned();
    let row=app.storage.read(move|db|db.query_row("SELECT i.id,i.chat_id,t.id,q.id,q.state FROM app_initiated_messages i LEFT JOIN turns t ON t.user_message_id=i.message_id LEFT JOIN session_queued_messages q ON q.chat_id=i.chat_id AND q.client_message_id=i.message_id WHERE i.source_key=?1",[source],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?))).optional().map_err(AppStorageError::sqlite)).await.map_err(app_error)?;
    if let Some((id, _, turn, queued, state)) = row {
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
    Ok((vec![projection, delivery], owner))
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

fn field(input: &Value, key: &str) -> Result<String, GatewayApplicationError> {
    input[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| public(400, "invalid_arguments", &format!("{key} required")))
}

pub(super) async fn replay(app: &AppApplication) -> Result<(), GatewayApplicationError> {
    loop {
        let pending = app
            .dependencies
            .canon
            .canon_operation(AppCanonOperation::PendingQueue)
            .await?;
        let pending = pending
            .as_array()
            .ok_or_else(GatewayApplicationError::internal)?;
        if pending.is_empty() {
            return Ok(());
        }
        for intent in pending {
            apply(app, intent.clone()).await?;
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
