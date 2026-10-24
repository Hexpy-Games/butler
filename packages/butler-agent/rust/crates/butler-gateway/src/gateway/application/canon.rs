//! App identity/scope resolution, over the host-owned canon port.
mod events;
use super::*;
use AppCanonResource::{
    BacklogOrder, Canon, CreateEpic, CreatePlan, CreateTag, DeleteTag, EditEpic, EditPlan, EditTag,
    Epic, Plan, PlanOrder, Tags,
};
pub(super) use events::start;

pub(super) fn execute(app: &AppApplication, request: AppCanonRequest) -> ApplicationFuture<Value> {
    let app = app.clone_handle();
    Box::pin(async move {
        validate_scope(&app, &request).await?;
        let mut result = app.dependencies.canon.execute(request).await?;
        app.storage
            .read(move |db| {
                public_sessions(db, &mut result)?;
                Ok(result)
            })
            .await
            .map_err(app_error)
    })
}

async fn validate_scope(
    app: &AppApplication,
    request: &AppCanonRequest,
) -> Result<(), GatewayApplicationError> {
    let project = match request.resource {
        Plan | EditPlan | PlanOrder | Epic | EditEpic | EditTag | DeleteTag => {
            app.dependencies
                .canon
                .project_scope(request.resource, request.id.clone())
                .await?
        }
        Canon | CreatePlan | CreateEpic | BacklogOrder | Tags | CreateTag => request.id.clone(),
    };
    let exists = app
        .storage
        .read(move |db| projects::rows::active_by_id(db, &project).map(|p| p.is_some()))
        .await
        .map_err(app_error)?;
    if !exists {
        return Err(public(404, "project_not_found", "Project not found."));
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
                if matches!(key.as_str(), "session_id" | "home_session_id") {
                    if let Some(owner) = value.as_str()
                        && let Some(chat) = sessions::identity::resolve_owner(db, owner)?
                    {
                        *value = Value::String(chat);
                    }
                } else if key == "session_ids" {
                    if let Some(owners) = value.as_array_mut() {
                        for owner in owners {
                            if let Some(chat) = owner
                                .as_str()
                                .map(|s| sessions::identity::resolve_owner(db, s))
                                .transpose()?
                                .flatten()
                            {
                                *owner = Value::String(chat);
                            }
                        }
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
