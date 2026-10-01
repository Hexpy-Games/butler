//! The gateway's local bearer token.

use std::sync::Arc;

use axum::http::{HeaderMap, header};
use parking_lot::RwLock;

use super::crypto::constant_time_eq;

/// Local auth for the App gateway: whether a token is required and the
/// token every client (App, CLI, browser link) presents.
///
/// Clones share the token: when Settings → Security rotates the connection
/// code, every holder in the process (the gateway, its health checks and
/// the internal clients that call it) sees the new token at once.
#[derive(Clone, Default)]
pub struct LocalAuthConfig {
    /// Requests without a valid credential are refused.
    pub required: bool,
    token: Option<Arc<RwLock<Arc<str>>>>,
}

impl LocalAuthConfig {
    /// Requires `token` (trimmed; blank means unconfigured, which answers 503).
    pub fn required(token: Option<String>) -> Self {
        Self {
            required: true,
            token: token.and_then(|value| {
                let token = butler_core::public_text::trim_js_whitespace(&value);
                (!token.is_empty()).then(|| Arc::new(RwLock::new(Arc::from(token))))
            }),
        }
    }

    /// The configured token, when there is one.
    pub fn token(&self) -> Option<Arc<str>> {
        self.token.as_ref().map(|token| token.read().clone())
    }

    /// Replaces the token for every clone; `false` when none is configured
    /// (a blank token cannot be rotated into place).
    pub(crate) fn replace_token(&self, token: &str) -> bool {
        match &self.token {
            Some(current) if !token.is_empty() => {
                *current.write() = Arc::from(token);
                true
            }
            _ => false,
        }
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
