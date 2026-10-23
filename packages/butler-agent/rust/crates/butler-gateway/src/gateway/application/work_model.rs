//! App identity/scope resolution, over the host-owned local work-model port.
mod events;
mod task_sessions;
use super::*;
use AppWorkModelResource::{
    BacklogOrder, Canon, CreateEpic, CreatePlan, Cutover, EditEpic, EditPlan, Epic, Plan,
    PlanOrder, Queue, SessionWorks, TaskOwnership, TaskSession,
};
pub(super) fn start(app: &AppApplication) {
    events::start(app);
    task_sessions::start(app);
}

pub(super) fn execute(
    app: &AppApplication,
    mut request: AppWorkModelRequest,
) -> ApplicationFuture<Value> {
    let app = app.clone_handle();
    Box::pin(async move {
        validate_scope(&app, &request).await?;
        if matches!(request.resource, SessionWorks | TaskOwnership) {
            request.id = app.runtime_hint(&request.id).await?;
        }
        let resource = request.resource;
        let session = request.id.clone();

        let mut result = app.dependencies.work_model.execute(request).await?;
        if matches!(resource, TaskSession | SessionWorks | TaskOwnership) {
            task_sessions::drain(&app).await?;
        }
        app.storage
            .read(move |db| {
                if resource == SessionWorks {
                    result["decisions"] = task_sessions::decisions(db, &session)?;
                }
                public_sessions(db, &mut result)?;
                Ok(result)
            })
            .await
            .map_err(app_error)
    })
}

async fn validate_scope(
    app: &AppApplication,
    request: &AppWorkModelRequest,
) -> Result<(), GatewayApplicationError> {
    if request.resource == Cutover {
        return Ok(());
    }
    let scope = if matches!(request.resource, SessionWorks | TaskOwnership) {
        AppWorkModelScope::Session(request.id.clone())
    } else if request.resource == TaskSession {
        app.dependencies
            .work_model
            .task_scope(request.id.clone())
            .await?
    } else if request.resource == Queue {
        app.dependencies
            .work_model
            .work_scope(request.id.clone())
            .await?
    } else {
        let project = match request.resource {
            Plan | EditPlan | PlanOrder | Epic | EditEpic => {
                app.dependencies
                    .work_model
                    .project_scope(request.resource, request.id.clone())
                    .await?
            }
            Canon | CreatePlan | CreateEpic | BacklogOrder => request.id.clone(),
            SessionWorks | TaskSession | TaskOwnership | Cutover | Queue => {
                return Err(GatewayApplicationError::internal());
            }
        };
        AppWorkModelScope::Project(project)
    };
    let (code, message) = match &scope {
        AppWorkModelScope::Project(_) => ("project_not_found", "Project not found."),
        AppWorkModelScope::Session(_) => ("session_not_found", "Session not found."),
    };
    let exists = app
        .storage
        .read(move |db| match scope {
            AppWorkModelScope::Project(id) => {
                projects::rows::active_by_id(db, &id).map(|p| p.is_some())
            }
            AppWorkModelScope::Session(id) => {
                sessions::identity::resolve_owner(db, &id).map(|s| s.is_some())
            }
        })
        .await
        .map_err(app_error)?;
    if !exists {
        return Err(public(404, code, message));
    }
    Ok(())
}

/// Runtime owners stay internal; clients use the App chat ids in their routes.
pub(super) fn public_sessions(
    db: &rusqlite::Connection,
    value: &mut Value,
) -> Result<(), AppStorageError> {
    match value {
        Value::Array(items) => {
            for item in items {
                public_sessions(db, item)?;
            }
        }
        Value::Object(fields) => {
            for (key, value) in fields {
                if matches!(
                    key.as_str(),
                    "session_id"
                        | "home_session_id"
                        | "assignee_session_id"
                        | "reserved_session_id"
                        | "handoff_to_session_id"
                ) {
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

pub(super) use task_sessions::sql::LOOKUP_SESSION;
#[cfg(feature = "test-support")]
pub(super) fn task_session_queries() -> Vec<(&'static str, String)> {
    task_sessions::sql::ALL
        .iter()
        .map(|(name, sql)| (*name, (*sql).to_owned()))
        .collect()
}
