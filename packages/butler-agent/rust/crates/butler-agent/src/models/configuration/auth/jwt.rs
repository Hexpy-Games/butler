//! OpenAI JWT claim extraction with Node Buffer-compatible base64 tolerance.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Map, Value};

pub(crate) fn account_id_from_access_token(token: &str) -> Option<String> {
    let payload = decode_jwt_payload(token)?;
    let auth = payload
        .get("https://api.openai.com/auth")
        .and_then(Value::as_object);
    auth.and_then(|value| value.get("chatgpt_account_id"))
        .and_then(Value::as_str)
        .or_else(|| {
            auth.and_then(|value| value.get("account_id"))
                .and_then(Value::as_str)
        })
        .or_else(|| payload.get("sub").and_then(Value::as_str))
        .map(str::to_owned)
}

pub(crate) fn email_from_access_token(token: &str) -> Option<String> {
    decode_jwt_payload(token)?
        .get("email")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub(super) fn codex_account_id(auth: &Map<String, Value>, token: &str) -> Option<String> {
    auth.get("tokens")
        .and_then(Value::as_object)
        .and_then(|tokens| tokens.get("account_id"))
        .and_then(Value::as_str)
        .and_then(trimmed)
        .map(str::to_owned)
        .or_else(|| {
            let payload = decode_jwt_payload(token)?;
            let claims = payload.get("https://api.openai.com/auth")?.as_object()?;
            claims
                .get("chatgpt_account_id")
                .and_then(Value::as_str)
                .or_else(|| claims.get("account_id").and_then(Value::as_str))
                .map(str::to_owned)
        })
}

fn decode_jwt_payload(token: &str) -> Option<Map<String, Value>> {
    let part = token.split('.').nth(1)?;
    let mut normalized = part
        .chars()
        .filter_map(|character| match character {
            '-' => Some('+'),
            '_' => Some('/'),
            value
                if value.is_ascii_alphanumeric()
                    || value == '+'
                    || value == '/'
                    || value == '=' =>
            {
                Some(value)
            }
            _ => None,
        })
        .collect::<String>();
    while normalized.len() % 4 != 0 {
        normalized.push('=');
    }
    let bytes = STANDARD.decode(normalized).ok()?;
    // Lossy UTF-8 decoding matches the source's Buffer.toString("utf8").
    serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes))
        .ok()?
        .as_object()
        .cloned()
}

fn trimmed(value: &str) -> Option<&str> {
    let value = crate::public_text::trim_js_whitespace(value);
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests;
