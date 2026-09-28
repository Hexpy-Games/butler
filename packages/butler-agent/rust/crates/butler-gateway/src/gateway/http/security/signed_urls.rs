//! Signed, short-lived URLs for message files, which `<img>` elements and
//! the App's artifact viewer fetch without an Authorization header.
//!
//! Every JSON object with `"url": "/message-files/<id>"` in an authenticated
//! response (JSON bodies and live-event data) gains
//! `"signed_url": "/message-files/<id>?expires=<unix seconds>&signature=<mac>"`.
//! A valid, unexpired signature authorizes `GET` of that one path and nothing
//! else. Signing happens at the HTTP boundary, so stored events never carry a
//! signature that would be stale on replay.

use axum::body::{Body, Bytes, HttpBody, to_bytes};
use axum::http::header;
use axum::response::Response;
use serde_json::Value;

use super::SigningKey;
use crate::gateway::http::{HttpError, error::error_response};

/// Lifetime of a signed URL (the gateway default; configurable shorter).
#[cfg(test)]
const SIGNED_URL_TTL_SECONDS: u64 = 600;
/// A signature may name an expiry this far past `now + TTL` (clock steps).
const MAX_CLOCK_SKEW_SECONDS: u64 = 60;
const FILE_ROUTE_PREFIX: &str = "/message-files/";
const SIGNED_URL_FIELD: &str = "signed_url";
/// Bodies without this byte string have nothing to sign.
const JSON_MARKER: &[u8] = b"\"/message-files/";
/// Larger JSON bodies are passed through unsigned.
const MAX_DECORATED_BODY_BYTES: u64 = 32 * 1024 * 1024;

/// Signs and verifies message-file URLs with the gateway signing key.
pub(in crate::gateway::http) struct ResourceSigner {
    key: SigningKey,
    ttl_seconds: u64,
}

impl ResourceSigner {
    pub(in crate::gateway::http) fn new(key: SigningKey, ttl_seconds: u64) -> Self {
        Self { key, ttl_seconds }
    }

    /// `path?expires=..&signature=..`, valid for the configured lifetime.
    pub(in crate::gateway::http) fn sign(&self, path: &str, now: u64) -> String {
        let expires = now.saturating_add(self.ttl_seconds);
        let signature = self.key.mac(&message(path, expires));
        format!("{path}?expires={expires}&signature={signature}")
    }

    /// Whether `query` carries an unexpired signature for `GET path`.
    pub(in crate::gateway::http) fn verify(
        &self,
        path: &str,
        query: Option<&str>,
        now: u64,
    ) -> bool {
        if !is_file_path(path) {
            return false;
        }
        let (mut expires, mut signature) = (None, None);
        for (name, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
            match name.as_ref() {
                "expires" if expires.is_none() => expires = value.parse::<u64>().ok(),
                "signature" if signature.is_none() => signature = Some(value.into_owned()),
                _ => {}
            }
        }
        let (Some(expires), Some(signature)) = (expires, signature) else {
            return false;
        };
        let latest = now.saturating_add(self.ttl_seconds.saturating_add(MAX_CLOCK_SKEW_SECONDS));
        expires >= now && expires <= latest && self.key.verify(&message(path, expires), &signature)
    }

    /// Adds `signed_url` beside every message-file `url` of a JSON response.
    pub(in crate::gateway::http) async fn decorate_response(
        &self,
        response: Response,
        now: u64,
    ) -> Response {
        let is_json = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("application/json"));
        let size = response.body().size_hint().exact();
        let Some(size) = size.filter(|size| is_json && *size <= MAX_DECORATED_BODY_BYTES) else {
            return response;
        };
        let (mut parts, body) = response.into_parts();
        let Ok(bytes) = to_bytes(body, usize::try_from(size).unwrap_or(usize::MAX)).await else {
            return error_response(&HttpError::Internal);
        };
        let Some(decorated) = self.decorate_bytes(&bytes, now) else {
            return Response::from_parts(parts, Body::from(bytes));
        };
        parts.headers.remove(header::CONTENT_LENGTH);
        Response::from_parts(parts, Body::from(decorated))
    }

    /// The same for one live-event chunk (`id: N\ndata: <json>\n\n`).
    pub(in crate::gateway::http) fn decorate_event_chunk(&self, chunk: Bytes, now: u64) -> Bytes {
        let Some((head, json)) = split_event_chunk(&chunk) else {
            return chunk;
        };
        let Some(decorated) = self.decorate_bytes(json, now) else {
            return chunk;
        };
        let mut output = Vec::with_capacity(head.len() + decorated.len() + 2);
        output.extend_from_slice(head);
        output.extend_from_slice(&decorated);
        output.extend_from_slice(b"\n\n");
        Bytes::from(output)
    }

    /// The re-serialized JSON when it names a message file, otherwise `None`.
    fn decorate_bytes(&self, json: &[u8], now: u64) -> Option<Vec<u8>> {
        if !json
            .windows(JSON_MARKER.len())
            .any(|window| window == JSON_MARKER)
        {
            return None;
        }
        let mut value: Value = serde_json::from_slice(json).ok()?;
        self.decorate_value(&mut value, now);
        serde_json::to_vec(&value).ok()
    }

    fn decorate_value(&self, value: &mut Value, now: u64) {
        match value {
            Value::Array(items) => {
                for item in items {
                    self.decorate_value(item, now);
                }
            }
            Value::Object(object) => {
                for child in object.values_mut() {
                    self.decorate_value(child, now);
                }
                let signed = object
                    .get("url")
                    .and_then(Value::as_str)
                    .filter(|url| is_file_path(url))
                    .map(|url| self.sign(url, now));
                if let Some(signed) = signed {
                    object.insert(SIGNED_URL_FIELD.to_owned(), Value::String(signed));
                }
            }
            _ => {}
        }
    }
}

/// Whether `path` is exactly `/message-files/file-<uuid>`.
pub(in crate::gateway::http) fn is_file_path(path: &str) -> bool {
    path.strip_prefix(FILE_ROUTE_PREFIX)
        .and_then(|id| id.strip_prefix("file-"))
        .is_some_and(|uuid| {
            uuid.len() == 36
                && uuid
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        })
}

fn message(path: &str, expires: u64) -> String {
    format!("butler.signed-resource.v1\nGET\n{path}\n{expires}")
}

/// `(b"id: N\ndata: ", json)` of a live-event chunk.
fn split_event_chunk(chunk: &[u8]) -> Option<(&[u8], &[u8])> {
    const DATA: &[u8] = b"\ndata: ";
    let body = chunk.strip_suffix(b"\n\n")?;
    let start = body.windows(DATA.len()).position(|window| window == DATA)? + DATA.len();
    let (head, json) = body.split_at(start);
    (head.starts_with(b"id: ") && !json.contains(&b'\n')).then_some((head, json))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATH: &str = "/message-files/file-0b7c3a51-2d4e-4f7a-9c1b-6e8d5f2a3b4c";

    fn signer() -> ResourceSigner {
        ResourceSigner::new(
            SigningKey::derive("token-for-signing-tests"),
            SIGNED_URL_TTL_SECONDS,
        )
    }

    fn query(signed: &str) -> &str {
        signed.split_once('?').map_or("", |(_, query)| query)
    }

    /// Security boundary: a signature is bound to its path, key and expiry.
    #[test]
    fn signature_authorizes_one_path_until_it_expires() {
        let signer = signer();
        let now = 1_800_000_000;
        let signed = signer.sign(PATH, now);
        assert!(signer.verify(PATH, Some(query(&signed)), now));
        assert!(signer.verify(PATH, Some(query(&signed)), now + SIGNED_URL_TTL_SECONDS));
        assert!(!signer.verify(PATH, Some(query(&signed)), now + SIGNED_URL_TTL_SECONDS + 1));
        let other = "/message-files/file-11111111-1111-4111-8111-111111111111";
        assert!(!signer.verify(other, Some(query(&signed)), now));
        let foreign =
            ResourceSigner::new(SigningKey::derive("another-token"), SIGNED_URL_TTL_SECONDS);
        assert!(!foreign.verify(PATH, Some(query(&signed)), now));
        let far = now + SIGNED_URL_TTL_SECONDS + MAX_CLOCK_SKEW_SECONDS + 10;
        let forged_expiry =
            query(&signed).replace(&format!("expires={}", now + 600), &format!("expires={far}"));
        assert!(!signer.verify(PATH, Some(&forged_expiry), now));
        assert!(!signer.verify(PATH, None, now));
        assert!(!signer.verify("/settings", Some(query(&signed)), now));
    }

    #[test]
    fn decoration_adds_signed_url_beside_message_file_urls_only() {
        let signer = signer();
        let json = serde_json::json!({"data": {"messages": [
            {"attachments": [{"url": PATH}], "artifacts": [{"url": PATH, "kind": "image"}]},
            {"url": "/settings"},
            {"url": format!("{PATH}/x")},
        ]}});
        let bytes = serde_json::to_vec(&json).unwrap();
        let decorated: Value =
            serde_json::from_slice(&signer.decorate_bytes(&bytes, 7).unwrap()).unwrap();
        let messages = &decorated["data"]["messages"];
        let attachment = messages[0]["attachments"][0]["signed_url"]
            .as_str()
            .unwrap();
        assert!(attachment.starts_with(&format!("{PATH}?expires=607&signature=")));
        assert!(messages[0]["artifacts"][0]["signed_url"].is_string());
        assert!(messages[1].get("signed_url").is_none());
        assert!(messages[2].get("signed_url").is_none());
        assert!(
            signer
                .decorate_bytes(br#"{"url":"/settings"}"#, 7)
                .is_none()
        );

        let chunk = format!("id: 4\ndata: {{\"url\":\"{PATH}\"}}\n\n");
        let decorated = signer.decorate_event_chunk(Bytes::from(chunk), 7);
        let text = String::from_utf8(decorated.to_vec()).unwrap();
        assert!(
            text.starts_with("id: 4\ndata: {") && text.ends_with("}\n\n"),
            "{text}"
        );
        assert!(text.contains("\"signed_url\""), "{text}");
    }
}
