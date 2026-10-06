//! Unknown-field-preserving OAuth profile updates.

use serde_json::{Map, Value};

pub struct OpenAiAuthProfile {
    pub(super) raw: Map<String, Value>,
    pub(super) access_token: String,
    pub(super) refresh_token: Option<String>,
    pub(super) expires_at: Option<f64>,
}

impl OpenAiAuthProfile {
    pub fn as_json(&self) -> Value {
        Value::Object(self.raw.clone())
    }
}

pub(super) fn update_string(raw: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value.and_then(Value::as_str) {
        raw.insert(key.into(), value.into());
    }
}

pub(super) fn copy_string(raw: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    update_string(raw, key, value);
}

pub(super) fn update_number(
    raw: &mut Map<String, Value>,
    key: &str,
    value: Option<&Value>,
    now: i64,
) {
    if let Some(seconds) = value.and_then(Value::as_f64)
        && let Some(number) = serde_json::Number::from_f64(now as f64 + seconds * 1000.0)
    {
        raw.insert(key.into(), Value::Number(number));
    }
}

pub(super) fn update_claim(raw: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        raw.insert(key.into(), value.into());
    }
}

/// A dedicated profile may be a Butler login or a Codex CLI auth.json.
/// Keep the original object so unrelated Codex fields survive rotation.
pub(super) fn from_raw(raw: Map<String, Value>) -> Option<OpenAiAuthProfile> {
    let (access_token, refresh_token, expires_at) =
        if let Some(tokens) = raw.get("tokens").and_then(Value::as_object) {
            let access = tokens.get("access_token")?.as_str()?.to_owned();
            let expiry = raw
                .get("expiresAt")
                .and_then(Value::as_f64)
                .or_else(|| super::jwt::expires_at(&access));
            (
                access,
                tokens
                    .get("refresh_token")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                expiry,
            )
        } else {
            if raw.get("type").and_then(Value::as_str) != Some("oauth") {
                return None;
            }
            (
                raw.get("accessToken")?.as_str()?.to_owned(),
                raw.get("refreshToken")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                raw.get("expiresAt").and_then(Value::as_f64),
            )
        };
    Some(OpenAiAuthProfile {
        raw,
        access_token,
        refresh_token,
        expires_at,
    })
}

pub(super) fn rotated(
    mut profile: OpenAiAuthProfile,
    token: &Value,
    now: i64,
    now_iso: &str,
) -> OpenAiAuthProfile {
    let access = token
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or(&profile.access_token)
        .to_owned();
    let raw = &mut profile.raw;
    if let Some(tokens) = raw.get_mut("tokens").and_then(Value::as_object_mut) {
        tokens.insert("access_token".into(), access.clone().into());
        update_string(tokens, "refresh_token", token.get("refresh_token"));
        update_string(tokens, "id_token", token.get("id_token"));
        update_claim(
            tokens,
            "account_id",
            super::jwt::account_id_from_access_token(&access),
        );
        profile.refresh_token = tokens
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_owned);
        raw.insert("last_refresh".into(), now_iso.into());
    } else {
        raw.insert("accessToken".into(), access.clone().into());
        update_string(raw, "refreshToken", token.get("refresh_token"));
        update_claim(
            raw,
            "accountId",
            super::jwt::account_id_from_access_token(&access),
        );
        update_claim(raw, "email", super::jwt::email_from_access_token(&access));
        update_string(raw, "scope", token.get("scope"));
        raw.insert("updatedAt".into(), now_iso.into());
        profile.refresh_token = raw
            .get("refreshToken")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    update_number(raw, "expiresAt", token.get("expires_in"), now);
    profile.expires_at = raw
        .get("expiresAt")
        .and_then(Value::as_f64)
        .or_else(|| super::jwt::expires_at(&access));
    profile.access_token = access;
    profile
}
