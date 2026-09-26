//! Source-compatible local development CORS, applied before local auth.

use std::collections::HashSet;

use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;

const DEFAULT_ORIGIN: &str = "http://127.0.0.1:5173";

pub(super) struct DevCorsPolicy {
    origins: HashSet<String>,
    allow_local_loopback: bool,
}

impl DevCorsPolicy {
    pub(super) fn new(configured: Option<&str>) -> Self {
        let origins = configured
            .unwrap_or_default()
            .split(',')
            .filter_map(|value| normalize(value.trim()))
            .collect::<HashSet<_>>();
        if origins.is_empty() {
            return Self {
                origins: HashSet::from([DEFAULT_ORIGIN.to_owned()]),
                allow_local_loopback: true,
            };
        }
        Self {
            origins,
            allow_local_loopback: false,
        }
    }

    pub(super) fn allowed_origin(&self, request: &HeaderMap) -> Option<HeaderValue> {
        let origin = normalize(request.get(header::ORIGIN)?.to_str().ok()?)?;
        (self.allow_local_loopback || self.origins.contains(&origin))
            .then(|| HeaderValue::from_str(&origin).ok())
            .flatten()
    }
}

pub(super) fn apply(response: &mut Response, origin: Option<&HeaderValue>) {
    let Some(origin) = origin else { return };
    response
        .headers_mut()
        .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Origin"));
}

pub(super) fn preflight(origin: &HeaderValue) -> Response {
    let mut response = Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(axum::body::Body::empty())
        .expect("static preflight response");
    apply(&mut response, Some(origin));
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, PATCH, DELETE, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("authorization, content-type"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    response
}

fn normalize(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "http" {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    if !matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1") {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_loopback_and_explicit_origin_match_source_policy() {
        let default = DevCorsPolicy::new(None);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:3000"),
        );
        assert!(default.allowed_origin(&headers).is_some());
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://localhost:3000"),
        );
        assert!(default.allowed_origin(&headers).is_none());
        let explicit = DevCorsPolicy::new(Some("http://127.0.0.1:5173"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:3000"),
        );
        assert!(explicit.allowed_origin(&headers).is_none());
        headers.insert(header::ORIGIN, HeaderValue::from_static(DEFAULT_ORIGIN));
        assert!(explicit.allowed_origin(&headers).is_some());
    }
}
