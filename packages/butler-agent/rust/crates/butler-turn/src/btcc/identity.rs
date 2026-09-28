use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::btcc::BtccCode;
use crate::btcc::{BtccError, ContentRef};

pub(super) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

// Passthrough: generic JSON canonicalization/hashing over arbitrary documents.
pub(super) fn content_ref(kind: &str, body: &Value) -> Result<ContentRef, BtccError> {
    let sha256 = digest(&stable_json(body)?);
    Ok(ContentRef {
        id: digest(&format!("btcc-{kind}.v1\0{sha256}")),
        sha256,
    })
}

/// Serializes a typed value for a canonical body.
pub(super) fn json_value<T: serde::Serialize + ?Sized>(value: &T) -> Result<Value, BtccError> {
    serde_json::to_value(value).map_err(|error| {
        BtccError::detected(BtccCode::BtccJsonError, error.to_string()).with_source(error)
    })
}

// Passthrough: generic JSON canonicalization/hashing over arbitrary documents.
pub(super) fn stable_json(value: &Value) -> Result<String, BtccError> {
    butler_core::json::canonical_json(value, butler_core::json::CanonicalKeyOrder::Utf16Lexical)
        .map_err(identity_error)
}

// Passthrough: generic JSON canonicalization/hashing over arbitrary documents.
pub(super) fn sqlite_stable_json(value: &Value) -> Result<String, BtccError> {
    butler_core::json::canonical_json(
        value,
        butler_core::json::CanonicalKeyOrder::JsPropertyEnumeration,
    )
    .map_err(identity_error)
}

// Passthrough: generic JSON canonicalization/hashing over arbitrary documents.
pub(super) fn json_stringify_without(value: &Value, field: &str) -> Result<String, BtccError> {
    butler_core::json::stringify_without(value, field).map_err(identity_error)
}

fn identity_error(error: butler_core::json::JsonError) -> BtccError {
    BtccError::detected(BtccCode::CanonicalJson, error.to_string()).with_source(error)
}

#[cfg(test)]
pub(crate) mod tests;
