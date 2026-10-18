//! Authenticated read-only task graph and document routes.
use super::*;
use crate::gateway::AppTaskGraphQuery;
use butler_turn::btcc::TaskGraphScope as GraphScope;

pub(super) fn matches(uri: &Uri) -> bool {
    scope(uri).is_some()
}
fn scope(uri: &Uri) -> Option<GraphScope> {
    let parts: Vec<_> = uri.path().trim_start_matches('/').split('/').collect();
    match parts.as_slice() {
        ["sessions", id, "task-graphs"] => Some(GraphScope::Session((*id).into())),
        ["plans", id, "task-graph"] => Some(GraphScope::Plan((*id).into())),
        ["tasks", id, "document"] => Some(GraphScope::Task((*id).into())),
        _ => None,
    }
}
pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    if request.method() != Method::GET {
        return Err(HttpError::public(
            405,
            "read_only",
            "Task graphs are read-only.",
        ));
    }
    let mut scope = scope(uri).ok_or(HttpError::Internal)?;
    let (GraphScope::Session(id) | GraphScope::Plan(id) | GraphScope::Task(id)) = &mut scope;
    *id = subsessions::decode_component(id)?;
    let parameters = query(uri);
    let limit = parameters
        .get("limit")
        .map(|v| v.parse::<usize>())
        .transpose()
        .map_err(|_| HttpError::public(400, "limit_invalid", "Invalid page size."))?
        .unwrap_or(500)
        .clamp(1, 500);
    let data = state
        .application
        .task_graph_read(AppTaskGraphQuery {
            scope,
            revision: parameters.get("revision").cloned(),
            cursor: parameters.get("cursor").cloned(),
            limit,
            include_nodes: false,
        })
        .await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}
