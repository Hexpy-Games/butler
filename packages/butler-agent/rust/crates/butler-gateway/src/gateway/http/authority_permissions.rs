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
    #[cfg(feature = "e2e-fixtures")]
    let started = std::time::Instant::now();
    let response = json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: Listed {
                permissions: grants,
            },
        },
    );
    #[cfg(feature = "e2e-fixtures")]
    if std::env::var("BUTLER_E2E_STORAGE_METRICS").as_deref() == Ok("1") {
        eprintln!(
            "approvals-profile serialize_us={}",
            started.elapsed().as_micros()
        );
    }
    response
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
        || input.grants.iter().any(|g| {
            (!g.grant_ref.starts_with("rule-") && g.session_id.trim().is_empty())
                || g.grant_ref.trim().is_empty()
        })
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

pub(super) async fn folders(
    state: &HttpState,
    path: &str,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    use axum::http::Method;
    let data = match (request.method(), path) {
        (&Method::GET, "/allowed-folders") => {
            json!({"folders":state.application.allowed_folders().await?})
        }
        (&Method::POST, "/allowed-folders" | "/allowed-folders/remove") => {
            let remove = path.ends_with("/remove");
            let body = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
            let value: serde_json::Value = serde_json::from_slice(&body)
                .map_err(|_| HttpError::public(400, "invalid_request", "Invalid folder."))?;
            let field = if remove { "rule_id" } else { "path" };
            let value = value[field]
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| HttpError::public(400, "invalid_request", "Invalid folder."))?;
            if remove {
                state
                    .application
                    .remove_allowed_folder(value.into())
                    .await?;
            } else {
                state.application.add_allowed_folder(value.into()).await?;
            }
            json!({"ok":true})
        }
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}
