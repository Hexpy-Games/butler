//! Electron folder selection is authorized by the source v1 HMAC token.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;

use super::error;
use crate::gateway::GatewayApplicationError;
use crate::gateway::crypto::{constant_time_eq, hmac_sha256_base64};

pub(super) fn selected_path(
    token: &str,
    secret: Option<&str>,
) -> Result<String, GatewayApplicationError> {
    let secret = secret.filter(|value| !value.is_empty()).ok_or_else(|| {
        error(
            403,
            "folder_selection_unavailable",
            "Project folder selection is unavailable.",
        )
    })?;
    let mut parts = token.split('.');
    let (Some("v1"), Some(payload), Some(signature)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(invalid());
    };
    if payload.is_empty() || signature.is_empty() {
        return Err(invalid());
    }
    let expected = hmac_sha256_base64(secret.as_bytes(), payload.as_bytes());
    if !constant_time_eq(expected.as_bytes(), signature.as_bytes()) {
        return Err(invalid());
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|source| invalid().with_source(source))?;
    let value: Value =
        serde_json::from_slice(&decoded).map_err(|source| invalid().with_source(source))?;
    if value
        .get("expires_at")
        .and_then(Value::as_f64)
        .is_some_and(|expiry| current_ms() > expiry)
    {
        return Err(error(
            400,
            "folder_selection_expired",
            "Project folder selection has expired.",
        ));
    }
    let path = value
        .get("path")
        .and_then(Value::as_str)
        .filter(|value| !butler_core::public_text::trim_js_whitespace(value).is_empty())
        .ok_or_else(invalid)?;
    Ok(path.to_owned())
}

fn current_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_millis() as f64)
}

fn invalid() -> GatewayApplicationError {
    error(
        400,
        "folder_selection_invalid",
        "Project folder selection is invalid.",
    )
}
