//! A native app trades a pairing code for its own device token (JSON); see
//! `connect` for browsers.
use super::super::{HttpError, HttpState, error::json, read_body_with_limit};
use super::browser_session::{Decision, PairingRequest};
use super::keys::Keyed;
use crate::gateway::{
    ButlerAccountRequest, DeviceKind, GatewayApplicationError, PUSH_KINDS,
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
pub(in crate::gateway::http) const DEVICE_PUSH_PATH: &str = "/devices/self/push";

#[derive(Deserialize)]
struct PushRequest {
    token: Option<String>,
    lang: Option<Value>,
    kinds: Option<Value>,
}

#[derive(Deserialize)]
struct PairRequest {
    code: String,
    device_name: String,
    platform: String,
    #[serde(default)]
    match_code: String,
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
    validate_match_code(&pair.match_code)?;
    let code = pair.code.trim();
    if code.len() != 8 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(super::connect::invalid_code());
    }
    let pairing = PairingRequest {
        device_name: name.into(),
        platform: pair.platform.trim().to_ascii_lowercase(),
        match_code: pair.match_code,
    };
    let change = state.remote.changes.lock().await;
    let (keyed, pairing_id) =
        redeem_device(state, &key, code, &ip, pairing, noise_static.is_some()).await?;
    drop(change);
    let mut pending = wait_for_pairing(keyed, &pairing_id).await?;
    let _change = state.remote.changes.lock().await;
    let sessions = pending.keyed.sessions.as_ref().ok_or(HttpError::Internal)?;
    let response =
        paired_response(state, sessions, &pairing_id, name, &ip, kind, noise_static).await?;
    pending.disarm();
    Ok(response)
}

async fn redeem_device(
    state: &HttpState,
    key: &str,
    code: &str,
    ip: &str,
    pairing: PairingRequest,
    has_noise_static: bool,
) -> Result<(Arc<Keyed>, String), HttpError> {
    state.pairing.check(key)?;
    let keyed = state
        .security
        .sessions()
        .ok_or_else(|| super::connect::rejected(state, key))?;
    let sessions = keyed
        .sessions
        .as_ref()
        .ok_or_else(|| super::connect::rejected(state, key))?;
    if has_noise_static
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
    let Some(Some(pairing_id)) = sessions.redeem(code, true, ip, Some(pairing)) else {
        return Err(super::connect::rejected(state, key));
    };
    Ok((keyed, pairing_id))
}

pub(super) fn validate_match_code(code: &str) -> Result<(), HttpError> {
    if code.len() == 2 && code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Ok(());
    }
    Err(HttpError::public(
        400,
        "invalid_request",
        "match_code (2 digits) is required.",
    ))
}

pub(super) struct PendingPairing<'a> {
    keyed: Arc<Keyed>,
    id: Option<&'a str>,
}

impl PendingPairing<'_> {
    pub(super) fn disarm(&mut self) {
        self.id = None;
    }
}

impl Drop for PendingPairing<'_> {
    fn drop(&mut self) {
        if let Some(id) = self.id
            && let Some(sessions) = &self.keyed.sessions
        {
            sessions.abandon(id);
        }
    }
}

pub(super) async fn wait_for_pairing(
    keyed: Arc<Keyed>,
    id: &str,
) -> Result<PendingPairing<'_>, HttpError> {
    let pending = PendingPairing {
        keyed,
        id: Some(id),
    };
    let sessions = pending.keyed.sessions.as_ref().ok_or(HttpError::Internal)?;
    match sessions.wait_decision(id).await {
        Decision::Approved => Ok(pending),
        Decision::Rejected => Err(HttpError::public(
            403,
            "pairing_rejected",
            "The computer declined this device.",
        )),
        Decision::Expired => Err(HttpError::public(
            410,
            "pairing_expired",
            "No answer from the computer. Try again.",
        )),
    }
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

pub(in crate::gateway::http) async fn set_push_request(
    state: &Arc<HttpState>,
    access: super::Access,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    if access != super::Access::DeviceToken {
        return Err(HttpError::public(
            403,
            "device_token_required",
            "Only a paired device can register for notifications.",
        ));
    }
    let id = state
        .devices
        .token_device_id(request.headers())
        .ok_or_else(|| {
            HttpError::public(
                401,
                "local_auth_required",
                "Butler App local auth is required.",
            )
        })?;
    let body = read_body_with_limit(request.into_body(), 1024).await?;
    let PushRequest { token, lang, kinds } =
        serde_json::from_slice(&body).map_err(|_| HttpError::invalid_json())?;
    if token.as_deref().is_some_and(|token| !expo_token(token)) {
        return Err(HttpError::public(
            400,
            "invalid_request",
            "token must be an Expo push token.",
        ));
    }
    let lang = token
        .as_ref()
        .and(lang.as_ref())
        .and_then(Value::as_str)
        .filter(|lang| matches!(*lang, "ko" | "en"))
        .map(str::to_owned);
    let kinds = token
        .as_ref()
        .and(kinds.as_ref())
        .and_then(Value::as_array)
        .map(|kinds| {
            PUSH_KINDS
                .iter()
                .filter(|known| kinds.iter().any(|kind| kind.as_str() == Some(**known)))
                .copied()
                .collect::<Vec<_>>()
                .join(",")
        });
    state
        .application
        .set_device_push_token(id, token, lang, kinds)
        .await?;
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    Ok(response)
}

pub(in crate::gateway::http) async fn push_status_request(
    state: &Arc<HttpState>,
    access: super::Access,
) -> Result<Response, HttpError> {
    if access != super::Access::DeviceToken {
        return Err(HttpError::public(
            403,
            "device_token_required",
            "Only a paired device can view notification availability.",
        ));
    }
    let data = match state
        .application
        .setup()?
        .butler_account(ButlerAccountRequest::PushAvailable)
        .await
    {
        Ok(value) => value,
        Err(GatewayApplicationError::Public {
            status: 404, code, ..
        }) if code == "butler_account_disabled" => {
            serde_json::json!({"available": false})
        }
        Err(error) => return Err(error.into()),
    };
    super::super::setup::envelope(StatusCode::OK, data)
}

fn expo_token(value: &str) -> bool {
    value.len() <= 256
        && value
            .strip_prefix("ExponentPushToken[")
            .or_else(|| value.strip_prefix("ExpoPushToken["))
            .and_then(|inner| inner.strip_suffix(']'))
            .is_some_and(|inner| !inner.is_empty())
        && !value.chars().any(|c| c.is_whitespace() || c.is_control())
}
