use std::sync::Arc;

use axum::{body::Body, http::StatusCode, response::Response};
use serde_json::Value;

use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};

use super::{Client, HttpError, HttpState, json, read_body_with_limit, security_settings};

/// `GET /settings`; local clients also get `security`.
pub(super) async fn get(
    state: Arc<HttpState>,
    client: Option<Client>,
) -> Result<Response, HttpError> {
    let mut settings = state.application.read_settings().await?;
    security_settings::add_to_settings(&state, client, &mut settings);
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: settings,
        },
    )
}

/// `PATCH /settings`. A `security` object is taken out first: only a local
/// client may send one (else nothing changes), and it applies after the
/// other fields, to the listeners and the gateway settings file.
pub(super) async fn patch(
    state: Arc<HttpState>,
    request: axum::http::Request<Body>,
) -> Result<Response, HttpError> {
    let client = request.extensions().get::<Client>().copied();
    let bytes = read_body_with_limit(request.into_body(), 1024 * 1024).await?;
    let mut input: Value = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let security = match input
        .as_object_mut()
        .and_then(|input| input.remove("security"))
    {
        Some(value) => {
            security_settings::local_client(client)?;
            Some(security_settings::parse_patch(value)?)
        }
        None => None,
    };
    let only_security =
        security.is_some() && input.as_object().is_some_and(serde_json::Map::is_empty);
    let mut settings = if only_security {
        state.application.read_settings().await?
    } else {
        state.application.update_settings(input).await?
    };
    if let Some(patch) = security {
        security_settings::apply(&state, patch).await?;
    }
    security_settings::add_to_settings(&state, client, &mut settings);
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: settings,
        },
    )
}
