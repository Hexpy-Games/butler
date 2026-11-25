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
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
    response::Response,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::sync::Arc;

pub(in crate::gateway::http) const DEVICE_PAIR_PATH: &str = "/devices/pair";
pub(in crate::gateway::http) const DEVICE_SELF_PATH: &str = "/devices/self";

#[derive(Deserialize)]
struct PairRequest {
    code: String,
    device_name: String,
    platform: String,
    #[serde(default)]
    noise_static: Option<String>,
}

#[derive(Serialize)]
struct PairedToken {
    device_id: String,
    device_token: String,
    butler_id: String,
    computer_name: String,
}

pub(in crate::gateway::http) async fn pair_device_request(
    state: &Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    super::require_json_body(&Method::POST, DEVICE_PAIR_PATH, request.headers())?;
    let peer = request
        .extensions()
        .get::<super::super::listeners::TunnelPeer>()
        .cloned();
    let ip = if peer.is_some() {
        "tunnel".into()
    } else {
        request
            .extensions()
            .get::<ConnectInfo<std::net::SocketAddr>>()
            .map(|info| info.0.ip().to_string())
            .unwrap_or_default()
    };
    let key = super::pairing_limit::client_key(&request);
    let body = read_body_with_limit(request.into_body(), super::connect::MAX_FORM_BYTES).await?;
    let pair: PairRequest = serde_json::from_slice(&body).map_err(|_| HttpError::invalid_json())?;
    let noise_static = validate_noise_static(pair.noise_static.as_deref(), peer)?;
    let name = pair.device_name.trim();
    let kind = DeviceKind::parse(&pair.platform).filter(|kind| *kind != DeviceKind::Browser);
    let Some(kind) = kind.filter(|_| {
        !name.is_empty() && name.chars().count() <= 64 && !name.chars().any(char::is_control)
    }) else {
        return Err(HttpError::public(
            400,
            "invalid_request",
            "device_name (1-64 characters) and platform (ios or android) are required.",
        ));
    };
    let code = pair.code.trim();
    if code.len() != 8 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(super::connect::invalid_code());
    }
    let _change = state.remote.changes.lock().await;
    state.pairing.check(&key)?;
    let keyed = state
        .security
        .sessions()
        .ok_or_else(|| super::connect::rejected(state, &key))?;
    let sessions = keyed
        .sessions
        .as_ref()
        .ok_or_else(|| super::connect::rejected(state, &key))?;
    if noise_static.is_some()
        && let Some(tunnel) = &state.tunnel
        && state.devices.noise_device_count() >= 5
        && !matches!(tunnel.plan().await?.as_deref(), Some("pro" | "enterprise"))
    {
        return Err(HttpError::public(
            403,
            "device_limit",
            "Remove a paired phone first.",
        ));
    }
    let Some(Some(pairing_id)) = sessions.redeem(code, true, &ip) else {
        return Err(super::connect::rejected(state, &key));
    };
    paired_response(state, sessions, &pairing_id, name, &ip, kind, noise_static).await
}

fn validate_noise_static(
    encoded: Option<&str>,
    peer: Option<super::super::listeners::TunnelPeer>,
) -> Result<Option<[u8; 32]>, HttpError> {
    let noise_static = encoded
        .map(|encoded| {
            URL_SAFE_NO_PAD
                .decode(encoded)
                .ok()
                .and_then(|bytes| bytes.try_into().ok())
                .ok_or_else(|| {
                    HttpError::public(400, "invalid_request", "Invalid Noise static key.")
                })
        })
        .transpose()?;
    if let Some(peer) = peer
        && noise_static != Some(peer.remote_static)
    {
        return Err(HttpError::public(
            403,
            "noise_static_mismatch",
            "Pair from the QR code on your computer.",
        ));
    }
    Ok(noise_static)
}

async fn paired_response(
    state: &HttpState,
    sessions: &super::browser_session::BrowserSessions,
    pairing_id: &str,
    name: &str,
    ip: &str,
    kind: DeviceKind,
    noise_static: Option<[u8; 32]>,
) -> Result<Response, HttpError> {
    let (id, device_token) = state
        .devices
        .pair_token(name, ip, kind, noise_static)
        .await?;
    let mut payload = Map::new();
    payload.insert("device_id".into(), Value::String(id.clone()));
    payload.insert("name".into(), Value::String(name.into()));
    state
        .application
        .publish_gateway_event("security.device_paired", payload)
        .await?;
    sessions.paired(pairing_id, &id);
    let mut response = json(
        StatusCode::CREATED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: PairedToken {
                device_id: id,
                device_token,
                butler_id: state.devices.butler_id().to_owned(),
                computer_name: butler_platform::instance::computer_name().to_owned(),
            },
        },
    )?;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

/// `DELETE /devices/self`: a phone revokes its own device token through the
/// desktop's revoke path and tells the desktop's device list.
pub(in crate::gateway::http) async fn revoke_self_request(
    state: &Arc<HttpState>,
    access: super::Access,
    headers: &HeaderMap,
) -> Result<Response, HttpError> {
    if access != super::Access::DeviceToken {
        return Err(HttpError::public(
            403,
            "device_token_required",
            "Only a paired device can disconnect itself.",
        ));
    }
    let id = state.devices.token_device_id(headers).ok_or_else(|| {
        HttpError::public(
            401,
            "local_auth_required",
            "Butler App local auth is required.",
        )
    })?;
    state.devices.revoke(Some(id.clone())).await?;
    let mut payload = Map::new();
    payload.insert("device_id".into(), Value::String(id));
    state
        .application
        .publish_gateway_event("security.device_revoked", payload)
        .await?;
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    Ok(response)
}
