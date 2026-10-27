//! Local authenticated draft detail and card/tool admission routes.
use super::*;
pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    parts: &[&str],
) -> Result<Response, HttpError> {
    if let ["canon", "proposals", id] = parts {
        let id = subsessions::decode_component(id)?;
        if !matches!(*request.method(), Method::GET | Method::POST) {
            return Err(HttpError::public(
                405,
                "method_not_allowed",
                "Method not allowed.",
            ));
        }
        let action = if request.method() == Method::GET {
            "get"
        } else {
            "resolve"
        };
        let mut input = if action == "get" {
            serde_json::json!({})
        } else {
            let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .map_err(|_| HttpError::invalid_json())?
        };
        input["id"] = serde_json::json!(id);
        input["by"] = serde_json::json!("card");
        let data = state
            .application
            .canon_proposal(action.into(), input)
            .await?;
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data,
            },
        );
    }
    if let ["sessions", session, "canon", action] = parts {
        if request.method() != Method::POST {
            return Err(HttpError::public(
                405,
                "method_not_allowed",
                "Method not allowed.",
            ));
        }
        let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
        let mut input: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
        input["session_id"] = serde_json::json!(subsessions::decode_component(session)?);
        let data = state
            .application
            .canon_proposal((*action).into(), input)
            .await?;
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data,
            },
        );
    }
    Err(HttpError::public(
        405,
        "method_not_allowed",
        "Method not allowed.",
    ))
}
