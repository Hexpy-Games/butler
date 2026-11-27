//! A browser redeems a one-time code; only POST accepts short pairing codes.
use super::super::{HttpError, HttpState, read_body_with_limit};
use super::browser_session::PairingRequest;
use super::connect_page::ConnectPage;
use super::device_pair::{validate_match_code, wait_for_pairing};
use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{HeaderValue, Method, Request, StatusCode, header},
    response::Response,
};
use serde_json::{Map, Value};
use std::sync::Arc;

pub(in crate::gateway::http) const CONNECT_PATH: &str = "/connect";
pub(in crate::gateway::http) const MAX_FORM_BYTES: usize = 4096;
const REMOTE_BROWSER: &str = "Remote device · browser";

pub(in crate::gateway::http) async fn connect_request(
    state: &Arc<HttpState>,
    request: Request<Body>,
    origin: &super::RequestOrigin,
) -> Result<Response, HttpError> {
    let form = *request.method() == Method::POST;
    let peer = request
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0);
    let secure = super::client_place::is_proxied_https(peer, request.headers(), origin);
    let ip = peer.map(|peer| peer.ip().to_string()).unwrap_or_default();
    let replaced = state.devices.presented(request.headers());
    let key = super::pairing_limit::client_key(&request);
    let encoded = if form {
        read_body_with_limit(request.into_body(), MAX_FORM_BYTES)
            .await?
            .to_vec()
    } else {
        request
            .uri()
            .query()
            .unwrap_or_default()
            .as_bytes()
            .to_vec()
    };
    let code = url::form_urlencoded::parse(&encoded)
        .find(|(name, _)| name == "code")
        .map(|(_, value)| value.trim().to_owned());
    let code = match code {
        Some(code) => code,
        None if form => String::new(),
        None => return Ok(ConnectPage::Ask.response()),
    };
    let pairing = pairing_request(form, &code, &encoded)?;
    let mut change = state.remote.changes.lock().await;
    state.pairing.check(&key)?;
    let keyed = state
        .security
        .sessions()
        .ok_or_else(|| rejected(state, &key))?;
    let sessions = keyed
        .sessions
        .as_ref()
        .ok_or_else(|| rejected(state, &key))?;
    let paired = sessions
        .redeem(&code, form, &ip, pairing)
        .ok_or_else(|| rejected(state, &key))?;
    let mut pending = if let Some(id) = &paired {
        drop(change);
        let pending = wait_for_pairing(keyed.clone(), id).await?;
        change = state.remote.changes.lock().await;
        Some(pending)
    } else {
        None
    };
    let name = if paired.is_some() {
        REMOTE_BROWSER
    } else {
        "This computer · browser"
    };
    let (response, id) = connect_response(state, replaced, name, &ip, secure).await?;
    if let (Some(pairing_id), Some(pending)) = (&paired, &mut pending) {
        sessions.paired(pairing_id, &id);
        pending.disarm();
    }
    drop(change);
    Ok(response)
}

fn pairing_request(
    form: bool,
    code: &str,
    encoded: &[u8],
) -> Result<Option<PairingRequest>, HttpError> {
    let mut digits = code.bytes().filter(|&byte| !matches!(byte, b'-' | b' '));
    if !form || digits.clone().count() != 8 || !digits.all(|byte| byte.is_ascii_digit()) {
        return Ok(None);
    }
    let match_code = url::form_urlencoded::parse(encoded)
        .find(|(name, _)| name == "match_code")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    validate_match_code(&match_code)?;
    Ok(Some(PairingRequest {
        device_name: REMOTE_BROWSER.into(),
        platform: "browser".into(),
        match_code,
    }))
}

async fn connect_response(
    state: &HttpState,
    replaced: Option<String>,
    name: &str,
    ip: &str,
    secure: bool,
) -> Result<(Response, String), HttpError> {
    if let Some(old) = replaced {
        state.devices.revoke(Some(old)).await?;
    }
    let (cookie, id) = state.devices.pair(name, ip, secure).await?;
    let mut payload = Map::new();
    payload.insert("device_id".into(), Value::String(id.clone()));
    payload.insert("name".into(), Value::String(name.into()));
    state
        .application
        .publish_gateway_event("security.device_paired", payload)
        .await?;
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SEE_OTHER;
    let headers = response.headers_mut();
    headers.insert(header::SET_COOKIE, cookie);
    headers.insert(header::LOCATION, HeaderValue::from_static("/"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    Ok((response, id))
}

pub(super) fn invalid_code() -> HttpError {
    HttpError::public(401, "invalid_connection_code", "That code is not valid.")
}

pub(super) fn rejected(state: &HttpState, key: &str) -> HttpError {
    state.pairing.reject(key);
    invalid_code()
}
