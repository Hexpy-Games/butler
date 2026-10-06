use super::{HttpError, HttpState, MAX_REQUEST_BODY_SIZE, json, read_body_with_limit};
use crate::gateway::{
    AppGrantRef, AppGrantView,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use serde::Deserialize;
use serde_json::json;

pub(super) async fn list(state: &HttpState) -> Result<Response, HttpError> {
    #[derive(serde::Serialize)]
    struct Listed {
        permissions: Vec<AppGrantView>,
    }
    let grants = state.application.authority_permissions().await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: Listed {
                permissions: grants,
            },
        },
    )
}

pub(super) async fn revoke(
    state: &HttpState,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    #[derive(Deserialize)]
    struct Input {
        grants: Vec<AppGrantRef>,
    }
    let body = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let input: Input = serde_json::from_slice(&body)
        .map_err(|_| HttpError::public(400, "invalid_request", "Invalid approvals."))?;
    if input.grants.is_empty()
        || input
            .grants
            .iter()
            .any(|g| g.session_id.trim().is_empty() || g.grant_ref.trim().is_empty())
    {
        return Err(HttpError::public(
            400,
            "invalid_request",
            "Invalid approvals.",
        ));
    }
    let revoked: Vec<_> = input.grants.iter().map(|g| g.grant_ref.clone()).collect();
    state
        .application
        .authority_revoke_permissions(input.grants)
        .await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: json!({"revoked":revoked}),
        },
    )
}
