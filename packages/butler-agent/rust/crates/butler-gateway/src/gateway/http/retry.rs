//! Distinct source retry actions for the existing Turn and current controls.

use std::sync::Arc;

use axum::{
    http::{Method, StatusCode, Uri},
    response::Response,
};

use super::{HttpError, HttpState, json};
use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};

pub(super) async fn route(
    state: Arc<HttpState>,
    method: &Method,
    uri: &Uri,
) -> Result<Option<Response>, HttpError> {
    if method != Method::POST {
        return Ok(None);
    }
    let Some(path) = uri.path().strip_prefix("/turns/") else {
        return Ok(None);
    };
    let (encoded_turn, current) = if let Some(id) = path.strip_suffix("/retry-current") {
        (id, true)
    } else if let Some(id) = path.strip_suffix("/retry") {
        (id, false)
    } else {
        return Ok(None);
    };
    if encoded_turn.is_empty() || encoded_turn.contains('/') {
        return Ok(None);
    }
    let turn_id = super::subsessions::decode_component(encoded_turn)?;
    let data = if current {
        serde_json::to_value(
            state
                .application
                .retry_turn_with_current_controls(turn_id)
                .await?,
        )
        .map_err(|_| HttpError::public(500, "internal_error", "Retry result is unavailable."))?
    } else {
        state.application.retry_turn(turn_id).await?
    };
    json(
        StatusCode::ACCEPTED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
    .map(Some)
}
