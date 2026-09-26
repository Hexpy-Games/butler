use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::btcc::{BtccError, ContentRef};

pub(super) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(super) fn content_ref(kind: &str, body: &Value) -> Result<ContentRef, BtccError> {
    let sha256 = digest(&stable_json(body)?);
    Ok(ContentRef {
        id: digest(&format!("btcc-{kind}.v1\0{sha256}")),
        sha256,
    })
}

pub(super) fn stable_json(value: &Value) -> Result<String, BtccError> {
    crate::json::canonical_json(value, crate::json::CanonicalKeyOrder::Utf16Lexical)
        .map_err(identity_error)
}

pub(super) fn sqlite_stable_json(value: &Value) -> Result<String, BtccError> {
    crate::json::canonical_json(value, crate::json::CanonicalKeyOrder::JsPropertyEnumeration)
        .map_err(identity_error)
}

pub(super) fn json_stringify_without(value: &Value, field: &str) -> Result<String, BtccError> {
    crate::json::stringify_without(value, field).map_err(identity_error)
}

fn identity_error(error: crate::json::JsonError) -> BtccError {
    BtccError::new("canonical_json", error.to_string())
}

#[cfg(test)]
mod tests;
