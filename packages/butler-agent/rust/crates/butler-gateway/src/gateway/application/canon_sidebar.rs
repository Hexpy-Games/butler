//! Canon navigation and startup replay, over the existing BTCC intent port.
mod order;
use super::*;
use rusqlite::OptionalExtension;
use serde_json::json;

pub(super) fn execute(
    app: &AppApplication,
    request: AppWorkModelRequest,
) -> ApplicationFuture<Value> {
    let app = app.clone_handle();
    Box::pin(async move {
        match request.resource {
            AppWorkModelResource::Sidebar => sidebar(&app, request.id).await,
            AppWorkModelResource::SidebarOrder => {
                reorder(
                    &app,
                    request.id,
                    request
                        .input
                        .ok_or_else(GatewayApplicationError::internal)?,
                )
                .await
            }
            AppWorkModelResource::Conversation => conversation(&app, request.id).await,
            _ => Err(GatewayApplicationError::internal()),
        }
    })
}

async fn canon(app: &AppApplication, id: String) -> Result<Value, GatewayApplicationError> {
    work_model::execute(
        app,
        AppWorkModelRequest {
            resource: AppWorkModelResource::Canon,
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
) -> Result<Value, GatewayApplicationError> {
    // The existing application layer enforces active project / canon visibility.
    work_model::execute(
        app,
        AppWorkModelRequest {
            resource: AppWorkModelResource::Epic,
            id: id.clone(),
            input: None,
        },
    )
    .await?;
    let mut result = app
        .dependencies
        .work_model
        .canon_operation(AppCanonOperation::Link {
            work_id: id,
            session_id: format!("butler/app-{}", app.dependencies.identity_clock.new_uuid()),
        })
        .await?;
    apply(app, result["intent"].take()).await?;
    result
        .as_object_mut()
        .ok_or_else(GatewayApplicationError::internal)?
        .remove("intent");
    app.storage
        .read(move |db| {
            work_model::public_sessions(db, &mut result)?;
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
    let op_copy = op.clone();
    let clock = app.dependencies.identity_clock.clone();
    let subscribers = app.subscribers.clone();
    app.storage
        .execute(move |db| {
            let exists = db
                .query_row(
                    "SELECT 1 FROM app_canon_conversations WHERE op_id=?1",
                    [&op_copy],
                    |r| r.get::<_, i64>(0),
                )
                .optional()
                .map_err(AppStorageError::sqlite)?
                .is_some();
            if !exists {
                sessions::canon::project(db, &subscribers, clock.as_ref(), &payload, &op_copy)?;
            }
            Ok(())
        })
        .await
        .map_err(app_error)?;
    if intent["state"] != "applied" {
        app.dependencies
            .work_model
            .canon_operation(AppCanonOperation::Applied {
                op_id: op,
                revision,
            })
            .await?;
    }
    Ok(())
}

pub(super) fn start(app: &AppApplication) {
    let Some(mut changes) = app.dependencies.work_model.changes() else {
        return;
    };
    let app = app.clone_handle();
    tokio::spawn(async move {
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
    let mut after = String::new();
    loop {
        let rows = app
            .dependencies
            .work_model
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
            if row["kind"] == "canon_conversation" {
                apply(app, row.clone()).await?;
            }
        }
    }
}
