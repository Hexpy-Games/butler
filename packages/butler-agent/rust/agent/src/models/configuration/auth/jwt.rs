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
mod tests {
    use base64::Engine as _;
    use serde_json::json;

    use super::*;

    fn token(payload: Value) -> String {
        let body = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).unwrap());
        format!("head.{body}.signature")
    }

    #[test]
    fn account_precedence_and_codex_authorization_excludes_sub_fallback() {
        let access = token(json!({
            "sub":"subject",
            "https://api.openai.com/auth": {
                "account_id":"legacy", "chatgpt_account_id":"chatgpt"
            }
        }));
        assert_eq!(
            account_id_from_access_token(&access).as_deref(),
            Some("chatgpt")
        );
        let raw = json!({"tokens":{"account_id":"stored"}})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(codex_account_id(&raw, &access).as_deref(), Some("stored"));

        let subject_only = token(json!({"sub":"subject"}));
        assert_eq!(
            account_id_from_access_token(&subject_only).as_deref(),
            Some("subject")
        );
        assert_eq!(codex_account_id(&Map::new(), &subject_only), None);
    }

    #[test]
    fn url_and_standard_base64_payloads_match_node_buffer_inputs() {
        let bytes = serde_json::to_vec(&json!({
            "sub":"source-account", "email":"person@example.com"
        }))
        .unwrap();
        for encoded in [
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes),
            base64::engine::general_purpose::STANDARD.encode(&bytes),
        ] {
            let token = format!("head.{encoded}.signature");
            assert_eq!(
                account_id_from_access_token(&token).as_deref(),
                Some("source-account")
            );
            assert_eq!(
                email_from_access_token(&token).as_deref(),
                Some("person@example.com")
            );
        }
    }
}
