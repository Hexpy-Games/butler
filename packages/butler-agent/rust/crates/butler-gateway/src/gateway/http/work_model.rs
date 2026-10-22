//! Local-only queue and canon routes; normal gateway auth protects this handler.
use super::*;
use crate::gateway::{
    AppWorkModelRequest,
    AppWorkModelResource::{
        BacklogOrder, Canon, CreateEpic, CreatePlan, Cutover, EditEpic, EditPlan, Epic, Plan,
        PlanOrder, Queue,
    },
};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let parts: Vec<_> = uri.path().trim_start_matches('/').split('/').collect();
    let (resource, id) = match (request.method(), parts.as_slice()) {
        (&Method::GET, ["work-model", "cutover"]) => (Cutover, ""),
        (&Method::GET, ["works", id, "tasks"])
        | (&Method::POST, ["works", id, "tasks", "edits"]) => (Queue, *id),
        (&Method::GET, ["projects", id, "canon"]) => (Canon, *id),
        (&Method::GET, ["canon", "plans", id]) => (Plan, *id),
        (&Method::GET, ["canon", "epics", id]) => (Epic, *id),
        (&Method::POST, ["projects", id, "canon", "plans"]) => (CreatePlan, *id),
        (&Method::PATCH, ["canon", "plans", id]) => (EditPlan, *id),
        (&Method::POST, ["canon", "plans", id, "order"]) => (PlanOrder, *id),
        (&Method::POST, ["projects", id, "canon", "backlog", "order"]) => (BacklogOrder, *id),
        (&Method::POST, ["projects", id, "canon", "epics"]) => (CreateEpic, *id),
        (&Method::PATCH, ["canon", "epics", id]) => (EditEpic, *id),
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
            resource,
            id,
            input,
        })
        .await?;
    let status = if matches!(resource, CreatePlan | CreateEpic) {
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
