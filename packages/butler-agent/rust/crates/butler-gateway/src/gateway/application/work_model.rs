//! App identity/scope resolution, over the host-owned local work-model port.
mod events;
use super::*;
pub(super) use events::start;

pub(super) fn execute(
    app: &AppApplication,
    request: AppWorkModelRequest,
) -> ApplicationFuture<Value> {
    let app = app.clone_handle();
    Box::pin(async move {
        let mut request = request;
        if request.resource == "queue" {
            request.id = app.runtime_hint(&request.id).await?;
        } else {
            let project = match request.resource.as_str() {
                "plan" | "edit_plan" | "plan_order" => {
                    let row = app
                        .dependencies
                        .work_model
                        .execute(AppWorkModelRequest {
                            resource: "plan".into(),
                            id: request.id.clone(),
                            input: None,
                        })
                        .await?;
                    row["project_id"].as_str().map(str::to_owned)
                }
                "epic" | "edit_epic" => {
                    let row = app
                        .dependencies
                        .work_model
                        .execute(AppWorkModelRequest {
                            resource: "epic".into(),
                            id: request.id.clone(),
                            input: None,
                        })
                        .await?;
                    row["scope_ref"].as_str().map(str::to_owned)
                }
                _ => Some(request.id.clone()),
            }
            .ok_or_else(GatewayApplicationError::internal)?;
            let exists = app
                .storage
                .read(move |db| projects::rows::active_by_id(db, &project).map(|p| p.is_some()))
                .await
                .map_err(app_error)?;
            if !exists {
                return Err(public(404, "project_not_found", "Project not found."));
            }
        }
        app.dependencies.work_model.execute(request).await
    })
}
