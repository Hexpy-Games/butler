//! Local-only canon routes; normal gateway auth protects this handler.
use super::*;
use crate::gateway::{
    AppCanonRequest,
    AppCanonResource::{
        BacklogOrder, Canon, CreateEpic, CreatePlan, CreateTag, DeleteTag, EditEpic, EditPlan,
        EditTag, Epic, EpicProgress, Plan, PlanOrder, Tags,
    },
};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let parts: Vec<_> = uri.path().trim_start_matches('/').split('/').collect();
    if matches!(
        parts.as_slice(),
        ["canon", "proposals", _] | ["sessions", _, "canon", _]
    ) {
        return super::canon_proposals::route(state, request, &parts).await;
    }
    resources(state, request, &parts).await
}

async fn resources(
    state: Arc<HttpState>,
    request: Request<Body>,
    parts: &[&str],
) -> Result<Response, HttpError> {
    if request.method() == Method::POST
        && let ["projects", id, "canon", "files"] = parts
    {
        let id = subsessions::decode_component(id)?;
        let _upload = state
            .uploads
            .acquire()
            .await
            .map_err(|_| HttpError::Internal)?;
        let input = super::message_files::parse_upload(request).await?;
        let file = state.application.upload_canon_file(id, input).await?;
        return json(
            StatusCode::CREATED,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: serde_json::json!({"file":file}),
            },
        );
    }
    let (resource, id) = match (request.method(), parts) {
        (&Method::GET, ["projects", id, "canon", "tags"]) => (Tags, *id),
        (&Method::POST, ["projects", id, "canon", "tags"]) => (CreateTag, *id),
        (&Method::PATCH, ["canon", "tags", id]) => (EditTag, *id),
        (&Method::DELETE, ["canon", "tags", id]) => (DeleteTag, *id),
        (&Method::GET, ["projects", id, "canon"]) => (Canon, *id),
        (&Method::GET, ["canon", "plans", id]) => (Plan, *id),
        (&Method::GET, ["canon", "epics", id]) => (Epic, *id),
        (&Method::GET, ["canon", "epics", id, "progress"]) => (EpicProgress, *id),
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
    } else if request.method() == Method::DELETE {
        Some(serde_json::json!({}))
    } else {
        let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
        Some(serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?)
    };
    let data = state
        .application
        .canon(AppCanonRequest {
            resource,
            id,
            input,
        })
        .await?;
    let status = if matches!(resource, CreatePlan | CreateEpic | CreateTag) {
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
