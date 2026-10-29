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
    match state.application.canon_proposal(action.into(), input).await {
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
