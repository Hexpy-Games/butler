//! The gateway's local bearer token.

use std::sync::Arc;

use axum::http::{HeaderMap, header};

use super::crypto::constant_time_eq;

/// Local auth for the App gateway: whether a token is required and the
/// token every client (App, CLI, browser link) presents.
#[derive(Clone, Default)]
pub struct LocalAuthConfig {
    /// Requests without a valid credential are refused.
    pub required: bool,
    token: Option<Arc<str>>,
}

impl LocalAuthConfig {
    /// Requires `token` (trimmed; blank means unconfigured, which answers 503).
    pub fn required(token: Option<String>) -> Self {
        Self {
            required: true,
            token: token.and_then(|value| {
                let token = butler_core::public_text::trim_js_whitespace(&value);
                (!token.is_empty()).then(|| Arc::from(token))
            }),
        }
    }

    /// The configured token, when there is one.
    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }
}

/// Whether `headers` carry `Authorization: Bearer <expected>`.
pub(super) fn bearer_matches(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(bearer_token)
        .is_some_and(|candidate| constant_time_eq(candidate.as_bytes(), expected.as_bytes()))
}

fn bearer_token(value: &str) -> Option<&str> {
    let separator = value.find(char::is_whitespace)?;
    let (scheme, remainder) = value.split_at(separator);
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = remainder.trim_start_matches(char::is_whitespace);
    (!token.is_empty()).then_some(token)
}
