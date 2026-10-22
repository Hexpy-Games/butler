//! Local-only queue and canon routes; normal gateway auth protects this handler.
use super::*;
use crate::gateway::AppWorkModelRequest;

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let parts: Vec<_> = uri.path().trim_start_matches('/').split('/').collect();
    let (resource, id) = match (request.method(), parts.as_slice()) {
        (&Method::GET, ["sessions", id, "work-queue"])
        | (&Method::POST, ["sessions", id, "work-queue", "edits"]) => ("queue", *id),
        (&Method::GET, ["projects", id, "canon"]) => ("canon", *id),
        (&Method::GET, ["canon", "plans", id]) => ("plan", *id),
        (&Method::GET, ["canon", "epics", id]) => ("epic", *id),
        (&Method::POST, ["projects", id, "canon", "plans"]) => ("create_plan", *id),
        (&Method::PATCH, ["canon", "plans", id]) => ("edit_plan", *id),
        (&Method::POST, ["canon", "plans", id, "order"]) => ("plan_order", *id),
        (&Method::POST, ["projects", id, "canon", "backlog", "order"]) => ("backlog_order", *id),
        (&Method::POST, ["projects", id, "canon", "epics"]) => ("create_epic", *id),
        (&Method::PATCH, ["canon", "epics", id]) => ("edit_epic", *id),
        _ => {
            return Err(HttpError::public(
                405,
                "method_not_allowed",
                "Method not allowed.",
            ));
        }
    };
    let id = subsessions::decode_component(id)?;
    let input = if request.method() == Method::GET {
        None
    } else {
        let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
        Some(serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?)
    };
    let data = state
        .application
        .work_model(AppWorkModelRequest {
            resource: resource.into(),
            id,
            input,
        })
        .await?;
    let status = if resource.starts_with("create_") {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    json(
        status,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}
