//! Public App approval ingress; the required port owns durable decisions and resume admission.

use axum::{
    body::Body,
    http::{Method, Request, StatusCode, Uri},
    response::Response,
};
use serde_json::{Value, json};

use super::{HttpError, HttpState, MAX_REQUEST_BODY_SIZE, json, query, read_body_with_limit};
use crate::gateway::{
    AppAuthorityDecisionInput,
    application::app_session_hint,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};
use std::sync::Arc;

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let method = request.method().clone();
    let path = uri.path();
    let session_id = query(uri)
        .get("session_id")
        .map(|value| crate::public_text::trim_js_whitespace(value))
        .filter(|value| !value.is_empty())
        .unwrap_or("general")
        .to_owned();
    let owner = app_session_hint(&session_id);

    if method == Method::GET && path == "/authority-requests" {
        let page = state.application.authority_list(owner).await?;
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: json!({
                    "session_id":session_id,
                    "requests":page.requests,
                    "permissions":page.permissions,
                }),
            },
        );
    }
    if method == Method::DELETE
        && let Some(grant) = path.strip_prefix("/authority-permissions/")
    {
        let grant = decode_component(grant)?;
        state.application.authority_revoke(owner, grant).await?;
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: json!({"revoked":true}),
            },
        );
    }
    if method == Method::POST
        && let Some(rest) = path.strip_prefix("/authority-requests/")
        && let Some((reference, action)) = rest.rsplit_once('/')
        && matches!(action, "allow" | "deny" | "modify")
        && !reference.contains('/')
    {
        let request_ref = decode_component(reference)?;
        let (allow_scope, alternative_input) = match action {
            "allow" => (Some(allow_scope(request).await?), None),
            "modify" => (None, Some(modify_input(request).await?)),
            _ => (None, None),
        };
        let decision = state
            .application
            .authority_decide(AppAuthorityDecisionInput {
                owner_session_id: owner,
                request_ref,
                action: action.to_owned(),
                allow_scope,
                alternative_input,
            })
            .await?;
        return json(
            StatusCode::ACCEPTED,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: json!({
                    "request_ref":decision.request_ref,
                    "decision":decision.decision,
                    "scheduled":decision.admitted,
                }),
            },
        );
    }
    Err(HttpError::public(404, "not_found", "Route not found."))
}

async fn allow_scope(request: Request<Body>) -> Result<String, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    if crate::public_text::trim_js_whitespace(&String::from_utf8_lossy(&bytes)).is_empty() {
        return Ok("once".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| scope_error())?;
    match value.get("scope").and_then(Value::as_str) {
        Some("once") => Ok("once".into()),
        Some("conversation") => Ok("conversation".into()),
        _ => Err(scope_error()),
    }
}

fn scope_error() -> HttpError {
    HttpError::public(400, "authority_scope_invalid", "Invalid permission scope.")
}

async fn modify_input(request: Request<Body>) -> Result<String, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| modify_error())?;
    let alternative = value
        .get("alternative")
        .filter(|value| !value.is_null())
        .or_else(|| value.get("instruction"));
    alternative
        .and_then(Value::as_str)
        .filter(|value| !crate::public_text::trim_js_whitespace(value).is_empty())
        .map(str::to_owned)
        .ok_or_else(modify_error)
}

fn modify_error() -> HttpError {
    HttpError::public(
        400,
        "authority_modify_input_missing",
        "Modify instruction is invalid.",
    )
}

fn decode_component(encoded: &str) -> Result<String, HttpError> {
    let mut bytes = Vec::with_capacity(encoded.len());
    let mut source = encoded.as_bytes().iter().copied();
    while let Some(byte) = source.next() {
        if byte == b'%' {
            let high = source.next().and_then(hex);
            let low = source.next().and_then(hex);
            let (Some(high), Some(low)) = (high, low) else {
                return Err(HttpError::Internal);
            };
            bytes.push((high << 4) | low);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).map_err(|_| HttpError::Internal)
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
