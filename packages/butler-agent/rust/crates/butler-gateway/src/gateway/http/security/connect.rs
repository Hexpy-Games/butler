//! A browser redeems a one-time code; only POST accepts short pairing codes.
use super::super::{HttpError, HttpState, read_body_with_limit};
use super::connect_page::ConnectPage;
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

pub(in crate::gateway::http) async fn connect_request(
    state: &Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let form = *request.method() == Method::POST;
    let ip = request
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip().to_string())
        .unwrap_or_default();
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
    let _change = state.remote.changes.lock().await;
    let keyed = state.security.sessions().ok_or_else(invalid_code)?;
    let sessions = keyed.sessions.as_ref().ok_or_else(invalid_code)?;
    let paired = sessions.redeem(&code, form, &ip).ok_or_else(invalid_code)?;
    let name = if paired.is_some() {
        "Remote device · browser"
    } else {
        "This computer · browser"
    };
    let (cookie, id) = state.devices.pair(name, &ip).await?;
    let mut payload = Map::new();
    payload.insert("device_id".into(), Value::String(id.clone()));
    payload.insert("name".into(), Value::String(name.into()));
    state
        .application
        .publish_gateway_event("security.device_paired", payload)
        .await?;
    if let Some(pairing_id) = paired {
        sessions.paired(&pairing_id, &id);
    }
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
    Ok(response)
}

fn invalid_code() -> HttpError {
    HttpError::public(401, "invalid_connection_code", "That code is not valid.")
}
