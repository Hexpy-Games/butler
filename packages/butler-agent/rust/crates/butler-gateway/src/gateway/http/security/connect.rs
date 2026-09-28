//! `/connect`: a browser trades a code for a session cookie. Two codes are
//! accepted:
//!
//! - a one-time code `butler open` minted (`GET /connect?code=..`, the link
//!   it opens, or the page's form);
//! - the connection code itself (Settings → Security), for a browser on
//!   another computer; it goes in the page's form (`POST`), so it never
//!   lands in a URL or the browser history.
//!
//! The cookie is keyed by the connection code: rotating the code ends every
//! session it issued.

use std::time::SystemTime;

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::Response;

use super::connect_page::ConnectPage;
use super::keys::Keyed;
use crate::gateway::crypto::constant_time_eq;

/// `GET /connect?code=..` and `POST /connect` (form): no credential needed.
pub(in crate::gateway::http) const CONNECT_PATH: &str = "/connect";
/// Longest form body `POST /connect` reads.
pub(in crate::gateway::http) const MAX_FORM_BYTES: usize = 4 * 1024;

/// `GET /connect[?code=..]`: the code page, or a session and a redirect.
pub(super) fn from_query(keyed: &Keyed, uri: &Uri, now: SystemTime) -> Response {
    match code_in(uri.query().unwrap_or_default().as_bytes()) {
        Some(code) => redeem(keyed, &code, now),
        None => ConnectPage::Ask.response(),
    }
}

/// `POST /connect` with `code=..` (`application/x-www-form-urlencoded`).
pub(super) fn from_form(keyed: &Keyed, body: &[u8], now: SystemTime) -> Response {
    match code_in(body) {
        Some(code) => redeem(keyed, &code, now),
        None => ConnectPage::Ask.response(),
    }
}

fn code_in(encoded: &[u8]) -> Option<String> {
    url::form_urlencoded::parse(encoded)
        .find(|(name, _)| name == "code")
        .map(|(_, value)| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// A one-time code, or the connection code (compared in constant time),
/// for a session cookie and a redirect to the App.
fn redeem(keyed: &Keyed, code: &str, now: SystemTime) -> Response {
    let Some(sessions) = keyed.sessions.as_ref() else {
        return ConnectPage::Rejected.response();
    };
    let connection_code = keyed
        .token
        .as_deref()
        .is_some_and(|token| constant_time_eq(code.as_bytes(), token.as_bytes()));
    let cookie = sessions
        .redeem(code, now)
        .or_else(|| connection_code.then(|| sessions.issue(now)).flatten());
    let Some(cookie) = cookie else {
        return ConnectPage::Rejected.response();
    };
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SEE_OTHER;
    let headers = response.headers_mut();
    headers.insert(header::SET_COOKIE, cookie);
    headers.insert(header::LOCATION, HeaderValue::from_static("/"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}
