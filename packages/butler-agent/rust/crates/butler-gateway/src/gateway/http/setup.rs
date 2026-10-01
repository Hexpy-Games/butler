//! First-run setup routes (#230):
//!
//! - `GET /setup/readiness`, `POST /setup/readiness/retry`
//! - `GET /setup/local-model-servers`
//! - `POST /setup/credentials/verify` (checks a key, stores nothing)
//! - `POST /credentials` (stores a key under a generated name)
//! - `GET /credentials`, `PATCH /credentials/{name}`,
//!   `DELETE /credentials/{name}?force=true` (#217: list, replace, delete)
//! - `POST /setup/oauth/start`, `GET /setup/oauth/{flow_id}`,
//!   `POST /setup/oauth/{flow_id}/cancel`

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode, Uri},
    response::Response,
};
use serde::{Serialize, de::DeserializeOwned};

use super::{HttpError, HttpState, json, read_body_with_limit, subsessions::decode_component};
use crate::gateway::{
    AppCredentialReplaceInput, AppOauthStartInput, AppProviderKeyInput,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

const MAX_SETUP_BODY: usize = 64 * 1024;

pub(super) fn handles(path: &str) -> bool {
    path.starts_with("/setup/") || path == "/credentials" || path.starts_with("/credentials/")
}

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let setup = state.application.setup()?;
    let method = request.method().clone();
    match (&method, uri.path()) {
        (&Method::GET, "/setup/readiness") => {
            let view = setup.readiness().borrow().clone();
            envelope(StatusCode::OK, view)
        }
        (&Method::POST, "/setup/readiness/retry") => {
            let input: ReadinessRetry = optional_body(request).await?;
            let view = if input.memory_model_only {
                setup.retry_memory_model()
            } else {
                setup.retry_readiness()
            };
            envelope(StatusCode::ACCEPTED, view)
        }
        (&Method::GET, "/setup/local-model-servers") => {
            envelope(StatusCode::OK, setup.local_model_servers().await?)
        }
        (&Method::POST, "/setup/credentials/verify") => {
            let input: AppProviderKeyInput = body(request).await?;
            envelope(StatusCode::OK, setup.verify_provider_key(input).await?)
        }
        (&Method::POST, "/credentials") => {
            let input: AppProviderKeyInput = body(request).await?;
            let saved = setup.save_provider_key(input).await?;
            let status = if saved.created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            envelope(status, saved)
        }
        (&Method::GET, "/credentials") => envelope(StatusCode::OK, setup.list_credentials().await?),
        (&Method::POST, "/setup/oauth/start") => {
            let input: AppOauthStartInput = optional_body(request).await?;
            envelope(StatusCode::OK, setup.start_oauth(input).await?)
        }
        (_, path) if path.starts_with("/credentials/") => {
            credential_route(&setup, request, uri).await
        }
        _ => oauth_flow_route(&setup, &method, uri.path()).await,
    }
}

#[derive(Default, serde::Deserialize)]
struct ReadinessRetry {
    #[serde(default)]
    memory_model_only: bool,
}

/// `PATCH /credentials/{name}` and `DELETE /credentials/{name}` (#217).
async fn credential_route(
    setup: &Arc<dyn crate::gateway::AppSetupPort>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let encoded = uri
        .path()
        .strip_prefix("/credentials/")
        .filter(|name| !name.is_empty() && !name.contains('/'))
        .ok_or_else(not_found)?;
    let name = decode_component(encoded)?;
    match request.method().clone() {
        Method::PATCH => {
            let input: AppCredentialReplaceInput = body(request).await?;
            envelope(StatusCode::OK, setup.replace_credential(name, input).await?)
        }
        Method::DELETE => {
            let force = force(uri)?;
            envelope(StatusCode::OK, setup.delete_credential(name, force).await?)
        }
        _ => Err(not_found()),
    }
}

/// `?force=true` (or `1`); absent means false.
fn force(uri: &Uri) -> Result<bool, HttpError> {
    let mut force = false;
    for (key, value) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()) {
        force = match (key.as_ref(), value.as_ref()) {
            ("force", "true" | "1") => true,
            ("force", "false" | "0") => false,
            _ => {
                return Err(HttpError::public(
                    400,
                    "invalid_request",
                    "The only query parameter is force=true or force=false.",
                ));
            }
        };
    }
    Ok(force)
}

/// `GET /setup/oauth/{flow_id}` and `POST /setup/oauth/{flow_id}/cancel`.
async fn oauth_flow_route(
    setup: &Arc<dyn crate::gateway::AppSetupPort>,
    method: &Method,
    path: &str,
) -> Result<Response, HttpError> {
    let Some(rest) = path.strip_prefix("/setup/oauth/") else {
        return Err(not_found());
    };
    let (encoded, cancel) = match rest.strip_suffix("/cancel") {
        Some(encoded) => (encoded, true),
        None => (rest, false),
    };
    if encoded.is_empty() || encoded.contains('/') {
        return Err(not_found());
    }
    let flow_id = decode_component(encoded)?;
    let view = match (method, cancel) {
        (&Method::GET, false) => setup.oauth_flow(flow_id).await?,
        (&Method::POST, true) => setup.cancel_oauth(flow_id).await?,
        _ => return Err(not_found()),
    };
    envelope(StatusCode::OK, view)
}

/// The JSON body as `T`.
async fn body<T: DeserializeOwned>(request: Request<Body>) -> Result<T, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_SETUP_BODY).await?;
    parse(&bytes)
}

/// The JSON body as `T`, or `T::default()` for an empty body.
async fn optional_body<T: DeserializeOwned + Default>(
    request: Request<Body>,
) -> Result<T, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_SETUP_BODY).await?;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(T::default());
    }
    parse(&bytes)
}

fn parse<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, HttpError> {
    serde_json::from_slice(bytes).map_err(|_| {
        HttpError::public(
            400,
            "invalid_request",
            "The request body is missing a field or has an unknown one.",
        )
    })
}

fn envelope<T: Serialize>(status: StatusCode, data: T) -> Result<Response, HttpError> {
    json(
        status,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

fn not_found() -> HttpError {
    HttpError::public(404, "not_found", "Route not found.")
}
