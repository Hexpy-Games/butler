//! A native app trades a pairing code for its own device token (JSON); see
//! `connect` for browsers.
use super::super::{HttpError, HttpState, error::json, read_body_with_limit};
use crate::gateway::{
    DeviceKind,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};
use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{HeaderValue, Method, Request, StatusCode, header},
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::sync::Arc;

pub(in crate::gateway::http) const DEVICE_PAIR_PATH: &str = "/devices/pair";

#[derive(Deserialize)]
struct PairRequest {
    code: String,
    device_name: String,
    platform: String,
}

#[derive(Serialize)]
struct PairedToken {
    device_id: String,
    device_token: String,
    butler_id: String,
}

pub(in crate::gateway::http) async fn pair_device_request(
    state: &Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    super::require_json_body(&Method::POST, DEVICE_PAIR_PATH, request.headers())?;
    let ip = request
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip().to_string())
        .unwrap_or_default();
    let body = read_body_with_limit(request.into_body(), super::connect::MAX_FORM_BYTES).await?;
    let PairRequest {
        code,
        device_name,
        platform,
    } = serde_json::from_slice(&body).map_err(|_| HttpError::invalid_json())?;
    let name = device_name.trim();
    let kind = DeviceKind::parse(&platform).filter(|kind| *kind != DeviceKind::Browser);
    let Some(kind) = kind.filter(|_| {
        !name.is_empty() && name.chars().count() <= 64 && !name.chars().any(char::is_control)
    }) else {
        return Err(HttpError::public(
            400,
            "invalid_request",
            "device_name (1-64 characters) and platform (ios or android) are required.",
        ));
    };
    let code = code.trim();
    if code.len() != 8 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(super::connect::invalid_code());
    }
    let _change = state.remote.changes.lock().await;
    let keyed = state
        .security
        .sessions()
        .ok_or_else(super::connect::invalid_code)?;
    let sessions = keyed
        .sessions
        .as_ref()
        .ok_or_else(super::connect::invalid_code)?;
    let Some(Some(pairing_id)) = sessions.redeem(code, true, &ip) else {
        return Err(super::connect::invalid_code());
    };
    let (id, device_token) = state.devices.pair_token(name, &ip, kind).await?;
    let mut payload = Map::new();
    payload.insert("device_id".into(), Value::String(id.clone()));
    payload.insert("name".into(), Value::String(name.into()));
    state
        .application
        .publish_gateway_event("security.device_paired", payload)
        .await?;
    sessions.paired(&pairing_id, &id);
    let mut response = json(
        StatusCode::CREATED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: PairedToken {
                device_id: id,
                device_token,
                butler_id: state.devices.butler_id().to_owned(),
            },
        },
    )?;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}
