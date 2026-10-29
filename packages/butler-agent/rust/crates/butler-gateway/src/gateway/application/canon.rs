//! App identity/scope resolution, over the host-owned canon port.
mod delegated;
mod events;
pub(super) mod files;
use super::*;
use AppCanonResource::{CreateEpic, EditEpic, Epic};
pub(super) use events::start;

pub(super) fn execute(
    app: &AppApplication,
    mut request: AppCanonRequest,
) -> ApplicationFuture<Value> {
    let app = app.clone_handle();
    Box::pin(async move {
        delegated::prepare(&app, &mut request).await?;
        validate_scope(&app, &request).await?;
        // A relay batch cannot consume this write's lifetime pin before canon commits.
        let writing = matches!(request.resource, CreateEpic | EditEpic);
        let _files = if writing {
            Some(app.canon_file_lifetimes.lock().await)
        } else {
            None
        };
        let ids = files::validate_write(&app, &request).await?;
        #[cfg(feature = "e2e-fixtures")]
        if writing {
            hold(&app, "canon_write").await?;
        }
        let delegated = request.delegate.is_some();
        let detail = matches!(request.resource, Epic | CreateEpic | EditEpic);
        let mut result = app.dependencies.canon.execute(request).await?;
        if delegated {
            return Ok(result);
        }
        app.storage
            .read(move |db| {
                public_sessions(db, &mut result)?;
                if detail {
                    result["attachments"] = if writing {
                        let ids = ids.unwrap_or_else(|| {
                            butler_canon::store::attachment_references_lenient(
                                result["description"].as_str().unwrap_or_default(),
                            )
                        });
                        files::from_ids(db, &ids)?
                    } else {
                        files::list(db, result["id"].as_str().unwrap_or_default())?
                    };
                }
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
    use AppCanonResource::{
        Activity, AllowGrant, BacklogOrder, Canon, CheckCriterion, Comment, CreateEpic, CreatePlan,
        CreateTag, DeleteTag, DenyGrant, EditEpic, EditPlan, EditTag, Epic, EpicProgress, Grants,
        List, Plan, PlanOrder, ProposeSpec, RevokeGrant, Spec, Tags,
    };
    let project = match request.resource {
        Grants | AllowGrant | DenyGrant | RevokeGrant => return Ok(()),
        List if request.id.is_empty() => return Ok(()),
        Spec | ProposeSpec | CheckCriterion | Activity | Comment | Plan | EditPlan | PlanOrder
        | Epic | EpicProgress | EditEpic | EditTag | DeleteTag => {
            app.dependencies
                .canon
                .project_scope(request.resource, request.id.clone())
                .await?
        }
        List | Canon | CreatePlan | CreateEpic | BacklogOrder | Tags | CreateTag => {
            request.id.clone()
        }
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

/// Reuse the platform fixture barrier without occupying a Tokio worker.
#[cfg(feature = "e2e-fixtures")]
pub(super) async fn hold(
    app: &AppApplication,
    point: &'static str,
) -> Result<(), GatewayApplicationError> {
    let shutdown = app.dependencies.service_shutdown.clone();
    tokio::task::spawn_blocking(move || {
        butler_platform::secure_fs::hold_point(point, || shutdown.is_cancelled())
    })
    .await
    .map_err(GatewayApplicationError::internal_from)?
    .map_err(GatewayApplicationError::internal_from)
}
