//! Authenticated work-model commands and immutable revision-bound reads.
use super::*;

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let tail = uri
        .path()
        .strip_prefix("/sessions/")
        .or_else(|| uri.path().strip_prefix("/plans/"))
        .ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))?;
    let (encoded, action) = tail
        .split_once('/')
        .ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))?;
    let session = super::subsessions::decode_component(encoded)?;
    let (view, input) = match (request.method(), action) {
        (&Method::GET, "instructions") => ("instructions", serde_json::to_value(query(uri))),
        (&Method::POST, "instructions") => {
            let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
            ("instruction", serde_json::from_slice::<Value>(&bytes))
        }
        (&Method::GET, "work-model-metrics") => ("metrics", serde_json::to_value(query(uri))),
        (&Method::GET, "work-summary") => ("summary", serde_json::to_value(query(uri))),
        (&Method::GET, "task-graph") => (
            if uri.path().starts_with("/plans/") {
                "plan_graph"
            } else {
                "graph"
            },
            serde_json::to_value(query(uri)),
        ),
        (&Method::GET, "work-spec") => ("spec", serde_json::to_value(query(uri))),
        (&Method::POST, "work-model") => {
            let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
            ("apply", serde_json::from_slice::<Value>(&bytes))
        }
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    let input = input
        .map_err(|_| HttpError::public(400, "invalid_input", "Invalid work-model request."))?;
    let data = state
        .application
        .work_model(session, view.into(), input)
        .await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

pub(super) fn matches(path: &str) -> bool {
    (path.starts_with("/sessions/") || path.starts_with("/plans/"))
        && [
            "/work-model-metrics",
            "/work-summary",
            "/work-model",
            "/task-graph",
            "/work-spec",
            "/instructions",
        ]
        .iter()
        .any(|suffix| path.ends_with(suffix))
}
