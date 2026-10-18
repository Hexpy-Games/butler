//! CORS for allowlisted browser origins (`app://butler`, the gateway's own
//! origin, the dev renderer). Preflight is answered before local auth, since
//! browsers never send credentials on it.

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;

use super::request_policy::RequestOrigin;

const ALLOWED_METHODS: &str = "GET, POST, PATCH, DELETE";
const ALLOWED_HEADERS: &str = "authorization, content-type, x-butler-admin";
const PREFLIGHT_MAX_AGE_SECONDS: &str = "600";

/// Marks every response as varying by Origin and echoes an allowlisted one.
pub(in crate::gateway::http) fn apply(response: &mut Response, origin: &RequestOrigin) {
    let headers = response.headers_mut();
    let varies = headers
        .get_all(header::VARY)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|name| name.trim().eq_ignore_ascii_case("origin"));
    if !varies {
        headers.append(header::VARY, HeaderValue::from_static("Origin"));
    }
    if let Some(origin) = origin.allowed() {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
    }
}

/// `204` preflight answer for an allowlisted origin.
pub(in crate::gateway::http) fn preflight(origin: &RequestOrigin) -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    apply(&mut response, origin);
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(ALLOWED_METHODS),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(ALLOWED_HEADERS),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static(PREFLIGHT_MAX_AGE_SECONDS),
    );
    response
}
