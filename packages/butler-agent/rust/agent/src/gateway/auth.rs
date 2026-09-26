use std::sync::Arc;

use axum::http::HeaderMap;
use subtle::ConstantTimeEq;

use super::http::HttpError;

#[derive(Clone, Default)]
pub(crate) struct LocalAuthConfig {
    pub required: bool,
    token: Option<Arc<str>>,
}

impl LocalAuthConfig {
    pub(crate) fn required(token: Option<String>) -> Self {
        Self {
            required: true,
            token: token.and_then(|value| {
                let token = crate::public_text::trim_js_whitespace(&value);
                (!token.is_empty()).then(|| Arc::from(token))
            }),
        }
    }
    pub(crate) fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }
}

pub(super) fn enforce(headers: &HeaderMap, config: &LocalAuthConfig) -> Result<(), HttpError> {
    if !config.required {
        return Ok(());
    }
    let Some(expected) = config.token.as_deref() else {
        return Err(HttpError::public(
            503,
            "local_auth_unconfigured",
            "Butler App local auth is not configured.",
        ));
    };
    let actual = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(bearer_token);
    let valid = actual.is_some_and(|candidate| {
        candidate.len() == expected.len()
            && bool::from(candidate.as_bytes().ct_eq(expected.as_bytes()))
    });
    if valid {
        Ok(())
    } else {
        Err(HttpError::public(
            401,
            "local_auth_required",
            "Butler App local auth is required.",
        ))
    }
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
