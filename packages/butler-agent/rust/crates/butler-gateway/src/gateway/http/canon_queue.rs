//! POST /sessions/{id}/canon/queue/edits uses one expected_graph_revision CAS.
//! Move operations accept exactly one of epic_id or ordered, nonempty epic_ids.
//! All selected epics must be unfinished and queued in the same source chain.
//! move_to_new_step inserts one stack at index after removing the selection;
//! join_stack appends to target_epic_id; move_between places that stack at index
//! in target_chain_id or appends it beside target_epic_id. A successful edit
//! advances the revision once. A stale revision returns 409 with graph_revision.
use super::*;
use crate::gateway::GatewayApplicationError;

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    parts: &[&str],
) -> Result<Response, HttpError> {
    let action = match (request.method(), parts) {
        (&Method::GET, ["sessions", _, "canon", "queue"]) => "queue_get",
        (&Method::POST, ["sessions", _, "canon", "queue"]) => "queue",
        (&Method::POST, ["sessions", _, "canon", "queue", "edits"]) => "queue_edit",
        (&Method::POST, ["sessions", _, "canon", "queue", "holds", _]) => "queue_hold",
        (&Method::POST, ["sessions", _, "canon", "queue", "take", _]) => "queue_take",
        _ => {
            return Err(HttpError::public(
                405,
                "method_not_allowed",
                "Method not allowed.",
            ));
        }
    };
    let mut input = if request.method() == Method::GET {
        serde_json::json!({})
    } else {
        let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
        serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|_| HttpError::invalid_json())?
    };
    if !input.is_object() {
        return Err(HttpError::invalid_json());
    }
    input["session_id"] = serde_json::json!(subsessions::decode_component(parts[1])?);
    if parts.len() == 6 {
        input["epic_id"] = serde_json::json!(subsessions::decode_component(parts[5])?);
    }
    let session = input["session_id"].clone();
    let tool_call = action == "queue"
        && input["arguments"].is_object()
        && input["turn_id"].is_string()
        && input["call_id"].is_string();
    let result = state.application.canon_proposal(action.into(), input).await;
    respond(state, session, result, tool_call).await
}

async fn respond(
    state: Arc<HttpState>,
    session: serde_json::Value,
    result: Result<serde_json::Value, GatewayApplicationError>,
    tool_call: bool,
) -> Result<Response, HttpError> {
    match result {
        // Expected tool refusals are data for the next model round. UI clients
        // retain their existing HTTP status and conflict response.
        Err(GatewayApplicationError::Public { code, message, .. }) if tool_call => json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: serde_json::json!({"ok":false,"error":{"code":code,"message":message}}),
            },
        ),
        Ok(data) => json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data,
            },
        ),
        Err(GatewayApplicationError::Public {
            status: 409,
            source: Some(source),
            ..
        }) => {
            let rev = source
                .downcast_ref::<crate::gateway::AppCanonConflict>()
                .ok_or(HttpError::Internal)?
                .revision;
            json(
                StatusCode::CONFLICT,
                serde_json::json!({"graph_revision":rev}),
            )
        }
        Err(GatewayApplicationError::Public { status: 409, .. }) => {
            let view = state
                .application
                .canon_proposal(
                    "queue_get".into(),
                    serde_json::json!({"session_id":session}),
                )
                .await?;
            json(
                StatusCode::CONFLICT,
                serde_json::json!({"graph_revision":view["graph_revision"]}),
            )
        }
        Err(error) => Err(error.into()),
    }
}
