//! App identity/scope resolution, over the host-owned local work-model port.
mod events;
use super::*;
use AppWorkModelResource::{
    BacklogOrder, Canon, CreateEpic, CreatePlan, EditEpic, EditPlan, Epic, Plan, PlanOrder, Queue,
};
pub(super) use events::start;

pub(super) fn execute(
    app: &AppApplication,
    request: AppWorkModelRequest,
) -> ApplicationFuture<Value> {
    let app = app.clone_handle();
    Box::pin(async move {
        if request.resource != Queue {
            let project = match request.resource {
                Plan | EditPlan | PlanOrder | Epic | EditEpic => {
                    app.dependencies
                        .work_model
                        .project_scope(request.resource, request.id.clone())
                        .await?
                }
                Canon | CreatePlan | CreateEpic | BacklogOrder => request.id.clone(),
                Queue => return Err(GatewayApplicationError::internal()),
            };
            let exists = app
                .storage
                .read(move |db| projects::rows::active_by_id(db, &project).map(|p| p.is_some()))
                .await
                .map_err(app_error)?;
            if !exists {
                return Err(public(404, "project_not_found", "Project not found."));
            }
        }
        let mut result = app.dependencies.work_model.execute(request).await?;
        app.storage
            .read(move |db| {
                public_sessions(db, &mut result)?;
                Ok(result)
            })
            .await
            .map_err(app_error)
    })
}

/// Runtime owners stay internal; clients use the App chat ids in their routes.
fn public_sessions(db: &rusqlite::Connection, value: &mut Value) -> Result<(), AppStorageError> {
    match value {
        Value::Array(items) => {
            for item in items {
                public_sessions(db, item)?;
            }
        }
        Value::Object(fields) => {
            for (key, value) in fields {
                if matches!(key.as_str(), "session_id" | "home_session_id") {
                    if let Some(owner) = value.as_str()
                        && let Some(chat) = sessions::identity::resolve_owner(db, owner)?
                    {
                        *value = Value::String(chat);
                    }
                } else {
                    public_sessions(db, value)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}
