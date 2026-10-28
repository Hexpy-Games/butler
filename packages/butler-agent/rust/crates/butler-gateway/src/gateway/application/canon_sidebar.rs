//! Canon navigation and startup replay, over the existing BTCC intent port.
mod order;
use super::*;
use rusqlite::OptionalExtension;
use serde_json::json;

async fn canon(app: &AppApplication, id: String) -> Result<Value, GatewayApplicationError> {
    canon::execute(
        app,
        AppCanonRequest {
            resource: AppCanonResource::Canon,
            id,
            input: None,
        },
    )
    .await
}

pub(crate) async fn sidebar(
    app: &AppApplication,
    project: String,
) -> Result<Value, GatewayApplicationError> {
    let value = canon(app, project.clone()).await?;
    app.storage
        .read(move |db| order::view(db, &project, value))
        .await
        .map_err(app_error)
}

pub(crate) async fn reorder(
    app: &AppApplication,
    project: String,
    input: Value,
) -> Result<Value, GatewayApplicationError> {
    let input = order::parse(input)?;
    let value = canon(app, project.clone()).await?;
    order::validate(&value, &input)?;
    let (kind, id, revision) = if input.group_key == "backlog" {
        (
            "backlog",
            project.clone(),
            value["backlog_revision"].clone(),
        )
    } else {
        let revision = value["plans"]
            .as_array()
            .and_then(|plans| plans.iter().find(|p| p["id"] == input.group_key))
            .map(|p| p["revision"].clone())
            .ok_or_else(GatewayApplicationError::internal)?;
        ("plan", input.group_key.clone(), revision)
    };
    let clock = app.dependencies.identity_clock.clone();
    let subscribers = app.subscribers.clone();
    app.storage
        .execute(move |db| {
            order::replace(db, &project, &input)?;
            let seq: i64 = db
                .query_row(
                    "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0)+1",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppStorageError::sqlite)?;
            events::append(
                db,
                &subscribers,
                "canon.changed",
                None,
                butler_core::json::json_object!({"project_id":project,"kind":kind,
                "id":id,"revision":revision,"origin":"local","event_seq":seq}),
                &clock.now_iso(),
            )?;
            order::view(db, &project, value)
        })
        .await
        .map_err(app_error)
}

pub(crate) async fn conversation(
    app: &AppApplication,
    id: String,
    session_id: Option<String>,
) -> Result<Value, GatewayApplicationError> {
    // The existing application layer enforces active project / canon visibility.
    let epic = canon::execute(
        app,
        AppCanonRequest {
            resource: AppCanonResource::Epic,
            id: id.clone(),
            input: None,
        },
    )
    .await?;
    let project = epic["project_id"]
        .as_str()
        .ok_or_else(GatewayApplicationError::internal)?
        .to_owned();
    let session_id = if let Some(chat) = session_id {
        Some(
            app.storage
                .read(move |db| {
                    let exists: bool = db
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM chats WHERE id=?1 AND kind='project' AND project_id=?2)",
                            [&chat, &project],
                            |r| r.get(0),
                        )
                        .map_err(AppStorageError::sqlite)?;
                    if !exists {
                        return Ok(None);
                    }
                    sessions::identity::runtime_hint(db, &chat).map(Some)
                })
                .await
                .map_err(app_error)?
                .ok_or_else(|| public(400, "work_model_invalid", "Session must be a conversation in the epic project."))?,
        )
    } else {
        None
    };
    let mut result = app
        .dependencies
        .canon
        .canon_operation(AppCanonOperation::Link {
            work_id: id,
            session_id,
            new_session_id: format!("butler/app-{}", app.dependencies.identity_clock.new_uuid()),
        })
        .await?;
    apply(app, result["intent"].take()).await?;
    result
        .as_object_mut()
        .ok_or_else(GatewayApplicationError::internal)?
        .remove("intent");
    app.storage
        .read(move |db| {
            canon::public_sessions(db, &mut result)?;
            Ok(result)
        })
        .await
        .map_err(app_error)
}

async fn apply(app: &AppApplication, intent: Value) -> Result<(), GatewayApplicationError> {
    let op = intent["op_id"]
        .as_str()
        .ok_or_else(GatewayApplicationError::internal)?
        .to_owned();
    let revision = intent["revision"]
        .as_i64()
        .ok_or_else(GatewayApplicationError::internal)?;
    let payload: Value = serde_json::from_str(
        intent["payload_json"]
            .as_str()
            .ok_or_else(GatewayApplicationError::internal)?,
    )
    .map_err(GatewayApplicationError::internal_from)?;
    validate_intent(app, &payload).await?;
    // The projection receipt is visible before its admission hook completes.
    // Replay and HTTP callers must share that whole lifetime before returning.
    let _projection = app.canon_projection_locks.acquire(op.clone()).await;
    if let Some(chat) = project(app, payload, op.clone()).await? {
        app.session_start_hook(chat, "created").await?;
    }
    if intent["state"] != "applied" {
        app.dependencies
            .canon
            .canon_operation(AppCanonOperation::Applied {
                op_id: op,
                revision,
            })
            .await?;
    }
    Ok(())
}

async fn validate_intent(
    app: &AppApplication,
    payload: &Value,
) -> Result<(), GatewayApplicationError> {
    for field in ["work_id", "project_id", "session_id"] {
        if payload[field].as_str().is_none_or(str::is_empty) {
            return Err(public(
                400,
                "work_model_invalid",
                "Invalid conversation intent.",
            ));
        }
    }
    let project_id = payload["project_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let active = app
        .storage
        .read(move |db| projects::rows::active_by_id(db, &project_id).map(|p| p.is_some()))
        .await
        .map_err(app_error)?;
    if !active {
        return Err(public(404, "project_not_found", "Project not found."));
    }
    let work_id = payload["work_id"]
        .as_str()
        .ok_or_else(|| public(400, "work_model_invalid", "Invalid conversation intent."))?;
    canon::execute(
        app,
        AppCanonRequest {
            resource: AppCanonResource::Epic,
            id: work_id.to_owned(),
            input: None,
        },
    )
    .await?;
    Ok(())
}

async fn project(
    app: &AppApplication,
    payload: Value,
    op: String,
) -> Result<Option<String>, GatewayApplicationError> {
    let clock = app.dependencies.identity_clock.clone();
    let subscribers = app.subscribers.clone();
    app.storage
        .execute(move |db| {
            let exists = db
                .query_row(
                    "SELECT 1 FROM app_canon_conversations WHERE op_id=?1",
                    [&op],
                    |r| r.get::<_, i64>(0),
                )
                .optional()
                .map_err(AppStorageError::sqlite)?
                .is_some();
            if exists {
                return Ok(None);
            }
            sessions::canon::project(db, &subscribers, clock.as_ref(), &payload, &op)
        })
        .await
        .map_err(app_error)
}

pub(super) fn start(app: &AppApplication) {
    let Some(mut changes) = app.dependencies.canon.changes() else {
        return;
    };
    let app = app.clone_handle();
    tokio::spawn(async move {
        if let Err(error) = startup(&app).await {
            tracing::error!(%error, "Canon queue startup reconciliation failed");
        }
        loop {
            changes.borrow_and_update();
            if let Err(error) = replay(&app).await {
                tracing::error!(%error,"Canon conversation replay failed");
            }
            tokio::select! {
                ()=app.dependencies.service_shutdown.cancelled()=>return,
                result=changes.changed()=>if result.is_err(){return;}
            }
        }
    });
}
async fn replay(app: &AppApplication) -> Result<(), GatewayApplicationError> {
    super::canon_proposals::recover(app).await?;
    super::canon_queue::replay(app).await?;
    conversations(app).await
}
async fn startup(app: &AppApplication) -> Result<(), GatewayApplicationError> {
    super::canon_proposals::recover(app).await?;
    conversations(app).await?;
    super::canon_queue::reconcile(app).await
}
async fn conversations(app: &AppApplication) -> Result<(), GatewayApplicationError> {
    let mut after = String::new();
    loop {
        let rows = app
            .dependencies
            .canon
            .canon_operation(AppCanonOperation::Pending {
                after: after.clone(),
            })
            .await?;
        let rows = rows
            .as_array()
            .ok_or_else(GatewayApplicationError::internal)?;
        if rows.is_empty() {
            return Ok(());
        }
        for row in rows {
            after = row["op_id"]
                .as_str()
                .ok_or_else(GatewayApplicationError::internal)?
                .to_owned();
            if matches!(
                row["kind"].as_str(),
                Some("canon_step" | "canon_hold" | "canon_take_here")
            ) {
                continue;
            }
            if row["kind"] == "canon_conversation"
                && let Err(error) = apply(app, row.clone()).await
            {
                tracing::error!(op_id = %after, %error, "Canon conversation intent failed");
                if matches!(
                    error,
                    GatewayApplicationError::Public {
                        status: 400 | 404,
                        ..
                    }
                ) {
                    // Deleted work/projects cannot be projected. Resolve the receipt so
                    // subsequent changes do not retry an impossible projection.
                    let result = app
                        .dependencies
                        .canon
                        .canon_operation(AppCanonOperation::Applied {
                            op_id: after.clone(),
                            revision: row["revision"]
                                .as_i64()
                                .ok_or_else(GatewayApplicationError::internal)?,
                        })
                        .await;
                    if let Err(error) = result {
                        tracing::error!(op_id = %after, %error, "Canon intent resolution failed");
                    }
                }
            }
        }
    }
}
