//! Authenticated App projection and Steward cancellation routes.

use axum::{
    body::Body,
    http::{Method, Request, StatusCode, Uri},
    response::Response,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subtle::ConstantTimeEq;

use super::{
    HttpError, HttpState, MAX_REQUEST_BODY_SIZE, json as response_json, query, read_body_with_limit,
};
use crate::gateway::{
    AppSessionViewPage, app_session_hint,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Option<Response>, HttpError> {
    if request.method() == Method::GET
        && matches!(
            uri.path(),
            "/session-view" | "/session-summary" | "/context-details"
        )
    {
        let parameters = query(uri);
        let public_id = parameters
            .get("session_id")
            .or_else(|| parameters.get("sessionId"))
            .cloned()
            .ok_or_else(|| HttpError::public(400, "session_required", "Session id is required."))?;
        let data = if uri.path() == "/session-summary" {
            state.application.session_summary_view(public_id).await?
        } else if uri.path() == "/context-details" {
            state.application.context_details(public_id).await?
        } else {
            let page = session_page(&parameters, &public_id, &state.session_cursor_secret)?;
            let data = state
                .application
                .session_view(public_id.clone(), page.clone())
                .await?;
            decorate_window(
                data,
                &public_id,
                &page,
                &parameters,
                &state.session_cursor_secret,
            )?
        };
        return Ok(Some(response_json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data,
            },
        )?));
    }
    let Some((relation, action)) = uri
        .path()
        .strip_prefix("/steward-relations/")
        .and_then(|tail| tail.rsplit_once('/'))
        .filter(|(id, action)| {
            !id.is_empty() && !id.contains('/') && matches!(*action, "cancel" | "resume")
        })
    else {
        return Ok(None);
    };
    if request.method() != Method::POST {
        return Ok(None);
    }
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let parent = body
        .get("parent_session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            HttpError::public(
                400,
                "parent_session_id_required",
                "parent_session_id is required.",
            )
        })?;
    let runtime = if parent.starts_with("steward-") {
        parent.into()
    } else {
        app_session_hint(parent)
    };
    let relation = decode_component(relation)?;
    let data = if action == "resume" {
        state
            .application
            .resume_subsession(runtime, relation)
            .await?
    } else {
        state
            .application
            .cancel_subsession(runtime, relation)
            .await?
    };
    Ok(Some(response_json(
        StatusCode::ACCEPTED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )?))
}

pub(super) fn decode_component(encoded: &str) -> Result<String, HttpError> {
    let mut bytes = Vec::with_capacity(encoded.len());
    let mut source = encoded.as_bytes().iter().copied();
    while let Some(byte) = source.next() {
        if byte == b'%' {
            let (Some(high), Some(low)) =
                (source.next().and_then(hex), source.next().and_then(hex))
            else {
                return Err(HttpError::Internal);
            };
            bytes.push((high << 4) | low);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).map_err(|_| HttpError::Internal)
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

const CURSOR_TTL_MS: u64 = 5 * 60 * 1_000;

fn session_page(
    parameters: &std::collections::HashMap<String, String>,
    session_id: &str,
    secret: &str,
) -> Result<AppSessionViewPage, HttpError> {
    if ["cursor", "after_cursor", "before_cursor", "beforeCursor"]
        .iter()
        .any(|key| parameters.contains_key(*key))
    {
        return Err(resync());
    }
    let after = parameters
        .get("cursor_token")
        .map(|token| decode_cursor(token, session_id, secret))
        .transpose()?;
    let before = parameters
        .get("before_cursor_token")
        .map(|token| decode_cursor(token, session_id, secret))
        .transpose()?;
    let limit = parameters
        .get("limit")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map_or(200, |value| (value.floor() as usize).clamp(1, 200));
    Ok(AppSessionViewPage {
        after_cursor: before.is_none().then_some(after).flatten(),
        before_cursor: before,
        limit,
    })
}

fn decorate_window(
    mut data: Value,
    session_id: &str,
    page: &AppSessionViewPage,
    parameters: &std::collections::HashMap<String, String>,
    secret: &str,
) -> Result<Value, HttpError> {
    let window = data
        .get_mut("message_window")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            HttpError::public(500, "session_view_invalid", "Session view is unavailable.")
        })?;
    if let Some(cursor) = window
        .get("previous_cursor")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0)
    {
        window.insert(
            "previous_cursor_token".into(),
            json!(encode_cursor(session_id, cursor, secret)?),
        );
    } else {
        window.remove("previous_cursor");
    }
    if let Some(cursor) = window
        .get("next_cursor")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0)
    {
        window.insert(
            "next_cursor_token".into(),
            json!(encode_cursor(session_id, cursor, secret)?),
        );
    }
    if let Some(cursor) = page.after_cursor {
        window.insert("requested_cursor".into(), json!(cursor));
        if let Some(token) = parameters.get("cursor_token") {
            window.insert("requested_cursor_token".into(), json!(token));
        }
    }
    if let Some(cursor) = page.before_cursor {
        window.insert("requested_before_cursor".into(), json!(cursor));
        if let Some(token) = parameters.get("before_cursor_token") {
            window.insert("requested_before_cursor_token".into(), json!(token));
        }
    }
    Ok(data)
}

fn encode_cursor(session_id: &str, cursor: u64, secret: &str) -> Result<String, HttpError> {
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(
            &json!({"v":1,"s":session_id,"c":cursor,"e":current_ms()+CURSOR_TTL_MS}),
        )
        .map_err(|_| {
            HttpError::public(
                500,
                "session_cursor_failed",
                "Session cursor is unavailable.",
            )
        })?,
    );
    let signature = URL_SAFE_NO_PAD.encode(hmac_sha256(secret.as_bytes(), payload.as_bytes()));
    Ok(format!("{payload}.{signature}"))
}

fn decode_cursor(token: &str, session_id: &str, secret: &str) -> Result<u64, HttpError> {
    let mut parts = token.split('.');
    let (Some(payload), Some(signature), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(resync());
    };
    let expected = URL_SAFE_NO_PAD.encode(hmac_sha256(secret.as_bytes(), payload.as_bytes()));
    if expected.len() != signature.len()
        || !bool::from(expected.as_bytes().ct_eq(signature.as_bytes()))
    {
        return Err(resync());
    }
    let decoded = URL_SAFE_NO_PAD.decode(payload).map_err(|_| resync())?;
    let value: Value = serde_json::from_slice(&decoded).map_err(|_| resync())?;
    let cursor = value.get("c").and_then(Value::as_u64).ok_or_else(resync)?;
    let expires = value.get("e").and_then(Value::as_u64).ok_or_else(resync)?;
    if value.get("v").and_then(Value::as_u64) != Some(1)
        || value.get("s").and_then(Value::as_str) != Some(session_id)
        || expires <= current_ms()
    {
        return Err(resync());
    }
    Ok(cursor)
}

fn hmac_sha256(secret: &[u8], payload: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 64];
    if secret.len() > key.len() {
        key[..32].copy_from_slice(&Sha256::digest(secret));
    } else {
        key[..secret.len()].copy_from_slice(secret);
    }
    let mut inner = Sha256::new();
    let mut outer = Sha256::new();
    inner.update(key.map(|byte| byte ^ 0x36));
    inner.update(payload);
    outer.update(key.map(|byte| byte ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

fn current_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn resync() -> HttpError {
    HttpError::public(
        409,
        "session_cursor_resync_required",
        "Session view cursor is invalid or expired; reload the session.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_cursor_is_signed_and_bound_to_session() {
        let Ok(token) = encode_cursor("session-a", 42, "secret") else {
            panic!("cursor encoding failed")
        };
        assert!(matches!(
            decode_cursor(&token, "session-a", "secret"),
            Ok(42)
        ));
        assert!(decode_cursor(&token, "session-b", "secret").is_err());
        let mut tampered = token.into_bytes();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'a' { b'b' } else { b'a' };
        assert!(
            decode_cursor(
                std::str::from_utf8(&tampered).unwrap(),
                "session-a",
                "secret"
            )
            .is_err()
        );

        let Ok(before) = encode_cursor("session-a", 21, "secret") else {
            panic!("before cursor encoding failed")
        };
        let Ok(after) = encode_cursor("session-a", 10, "secret") else {
            panic!("after cursor encoding failed")
        };
        let Ok(page) = session_page(
            &std::collections::HashMap::from([
                ("cursor_token".into(), after),
                ("before_cursor_token".into(), before),
                ("limit".into(), "2".into()),
            ]),
            "session-a",
            "secret",
        ) else {
            panic!("session page decoding failed")
        };
        assert_eq!(page.after_cursor, None);
        assert_eq!(page.before_cursor, Some(21));
        assert_eq!(page.limit, 2);
        assert!(
            session_page(
                &std::collections::HashMap::from([("cursor".into(), "21".into())]),
                "session-a",
                "secret",
            )
            .is_err()
        );
    }
}
