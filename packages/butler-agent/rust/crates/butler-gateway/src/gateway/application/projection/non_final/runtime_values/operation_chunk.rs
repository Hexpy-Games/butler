//! The source `createAgentTurnEvent` validates operation chunks before publication.

use base64::{Engine, alphabet, engine::general_purpose};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::gateway::application::storage::{AppStorageCode, AppStorageError};

const CHUNK_BYTES: usize = 32 * 1024;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const BASE64: general_purpose::GeneralPurpose = general_purpose::GeneralPurpose::new(
    &alphabet::STANDARD,
    general_purpose::GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
);

pub(super) fn normalize(
    payload: Option<&Map<String, Value>>,
) -> Result<Map<String, Value>, AppStorageError> {
    let empty = Map::new();
    let payload = payload.unwrap_or(&empty);
    let request_id = token(payload, "requestId")?;
    let result_id = token(payload, "resultId")?;
    let result_sha = diagnostic_digest(payload, "resultSha256");
    let chunk_index = integer(payload, "chunkIndex", false)?;
    let chunk_count = integer(payload, "chunkCount", true)?;
    let byte_start = integer(payload, "byteStart", false)?;
    let byte_end = integer(payload, "byteEnd", false)?;
    let byte_length = integer(payload, "byteLength", false)?;
    let content = payload
        .get("contentBase64")
        .and_then(Value::as_str)
        .filter(|value| value.len() <= CHUNK_BYTES * 2)
        .ok_or_else(invalid)?;
    let content_sha = diagnostic_digest(payload, "contentSha256");
    if chunk_index >= chunk_count || byte_start > byte_end || byte_end > byte_length {
        return Err(invalid());
    }
    // Bun accepts nonzero unused bits in otherwise well-formed padded Base64.
    // The source regex still requires the canonical alphabet and padding shape.
    let bytes = BASE64
        .decode(content)
        .map_err(|source| invalid().with_source(source))?;
    if bytes.len() as u64 != byte_end - byte_start {
        return Err(invalid());
    }
    if format!("{:x}", Sha256::digest(&bytes)) != content_sha {
        butler_core::diagnostic!(
            "warning: operation chunk content hash mismatch for {request_id}/{result_id}/{chunk_index}"
        );
    }
    let mut normalized = Map::new();
    for (key, value) in [
        ("requestId", Value::String(request_id.to_owned())),
        ("resultId", Value::String(result_id.to_owned())),
        ("resultSha256", Value::String(result_sha.to_owned())),
        ("chunkIndex", Value::from(chunk_index)),
        ("chunkCount", Value::from(chunk_count)),
        ("byteStart", Value::from(byte_start)),
        ("byteEnd", Value::from(byte_end)),
        ("byteLength", Value::from(byte_length)),
        ("contentBase64", Value::String(content.to_owned())),
        ("contentSha256", Value::String(content_sha.to_owned())),
    ] {
        normalized.insert(key.into(), value);
    }
    Ok(normalized)
}

fn token<'a>(payload: &'a Map<String, Value>, key: &str) -> Result<&'a str, AppStorageError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.encode_utf16().count() <= 512)
        .ok_or_else(invalid)
}

fn diagnostic_digest<'a>(payload: &'a Map<String, Value>, key: &str) -> &'a str {
    payload.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn integer(
    payload: &Map<String, Value>,
    key: &str,
    positive: bool,
) -> Result<u64, AppStorageError> {
    payload
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| {
            value.is_finite()
                && *value >= if positive { 1.0 } else { 0.0 }
                && *value <= MAX_SAFE_INTEGER
                && value.fract() == 0.0
        })
        .map(butler_core::json::saturating_u64)
        .ok_or_else(invalid)
}

fn invalid() -> AppStorageError {
    AppStorageError::new(
        AppStorageCode::OperationOutputChunkInvalid,
        "Invalid operation output chunk",
    )
}
