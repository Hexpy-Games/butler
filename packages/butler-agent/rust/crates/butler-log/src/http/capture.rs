//! Bounded body samples; digest and length cover every consumed byte.
use reqwest::header::HeaderMap;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
const LIMIT: usize = 1024 * 1024;
#[derive(Default)]
pub(super) struct Capture {
    bytes: Vec<u8>,
    length: u64,
    hash: Sha256,
    content_type: String,
    text: bool,
}
impl Capture {
    pub(super) fn new(headers: &HeaderMap) -> Self {
        let content_type = headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let mime = content_type.split(';').next().unwrap_or_default().trim();
        let text = mime.is_empty()
            || mime.starts_with("text/")
            || matches!(
                mime,
                "application/json" | "application/xml" | "application/x-www-form-urlencoded"
            )
            || mime.ends_with("+json")
            || mime.ends_with("+xml");
        Self {
            content_type,
            text,
            ..Self::default()
        }
    }
    pub(super) fn observe(&mut self, bytes: &[u8]) {
        self.length += bytes.len() as u64;
        self.hash.update(bytes);
        if self.text {
            let remaining = LIMIT - self.bytes.len();
            self.bytes
                .extend_from_slice(&bytes[..remaining.min(bytes.len())]);
        }
    }
    pub(super) fn retained_bytes(&self) -> usize {
        self.bytes.capacity()
    }
    pub(super) fn is_text(&self) -> bool {
        self.text
    }
    pub(super) fn content(&self) -> Value {
        if self.text && self.length <= LIMIT as u64 {
            let mut headers = HeaderMap::new();
            if let Ok(value) = self.content_type.parse() {
                headers.insert("content-type", value);
            }
            return super::observe::content(&self.bytes, &headers);
        }
        // Large/binary messages retain metadata, never a partial secret or base64 payload.
        json!({"content_type":self.content_type,"length":self.length,"sha256":format!("{:x}",self.hash.clone().finalize()),"truncated":self.text && self.length > LIMIT as u64})
    }
}
