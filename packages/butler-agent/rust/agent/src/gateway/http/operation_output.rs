//! Exact, paged operation-result read for the Desktop inspector.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode, Uri},
    response::Response,
};

use super::{HttpError, HttpState, json, query};
use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Option<Response>, HttpError> {
    if request.method() != Method::GET {
        return Ok(None);
    }
    let Some(path) = uri.path().strip_prefix("/turns/") else {
        return Ok(None);
    };
    let segments = path.split('/').collect::<Vec<_>>();
    let [encoded_turn, "operations", encoded_request, "output"] = segments.as_slice() else {
        return Ok(None);
    };
    if encoded_turn.is_empty() || encoded_request.is_empty() {
        return Ok(None);
    }
    let turn_id = super::subsessions::decode_component(encoded_turn)?;
    let request_id = super::subsessions::decode_component(encoded_request)?;
    let parameters = query(uri);
    let result_id = parameters
        .get("result_id")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| HttpError::public(400, "result_required", "Result id is required."))?
        .clone();
    let offset = match parameters.get("offset") {
        Some(raw) => js_nonnegative_offset(raw).ok_or_else(|| {
            HttpError::public(400, "offset_invalid", "Offset must be non-negative.")
        })?,
        None => 0,
    };
    let output = state
        .application
        .get_operation_output(turn_id, request_id, result_id, offset)
        .await?
        .ok_or_else(|| {
            HttpError::public(
                404,
                "operation_output_not_found",
                "Operation output is not available for this turn.",
            )
        })?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: output,
        },
    )
    .map(Some)
}

fn js_nonnegative_offset(raw: &str) -> Option<u64> {
    let value = raw.trim();
    let parsed = if value.is_empty() {
        0.0
    } else if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        u64::from_str_radix(hex, 16).ok()? as f64
    } else if let Some(binary) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        u64::from_str_radix(binary, 2).ok()? as f64
    } else if let Some(octal) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        u64::from_str_radix(octal, 8).ok()? as f64
    } else {
        value.parse::<f64>().ok()?
    };
    (parsed.is_finite()
        && parsed.fract() == 0.0
        && (0.0..=9_007_199_254_740_991.0).contains(&parsed))
    .then_some(parsed as u64)
}
