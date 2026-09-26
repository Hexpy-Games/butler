//! The source `createAgentTurnEvent` validates operation chunks before publication.

use base64::{Engine, alphabet, engine::general_purpose};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::gateway::application::storage::AppStorageError;

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
    let result_sha = digest(payload, "resultSha256")?;
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
    let content_sha = digest(payload, "contentSha256")?;
    if chunk_index >= chunk_count || byte_start > byte_end || byte_end > byte_length {
        return Err(invalid());
    }
    // Bun accepts nonzero unused bits in otherwise well-formed padded Base64.
    // The source regex still requires the canonical alphabet and padding shape.
    let bytes = BASE64.decode(content).map_err(|_| invalid())?;
    if bytes.len() as u64 != byte_end - byte_start
        || format!("{:x}", Sha256::digest(&bytes)) != content_sha
    {
        return Err(invalid());
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

fn digest<'a>(payload: &'a Map<String, Value>, key: &str) -> Result<&'a str, AppStorageError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(invalid)
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
        .map(|value| value as u64)
        .ok_or_else(invalid)
}

fn invalid() -> AppStorageError {
    AppStorageError::new(
        "operation_output_chunk_invalid",
        "Invalid operation output chunk",
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::normalize;

    #[test]
    fn committed_chunk_is_validated_and_extras_are_removed() {
        let mut payload = json!({
            "requestId":"request", "resultId":"result",
            "resultSha256":"a".repeat(64), "chunkIndex":0, "chunkCount":1,
            "byteStart":0, "byteEnd":1, "byteLength":1,
            "contentBase64":"YQ==",
            "contentSha256":"ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
            "privateExtra":"discarded"
        });
        let normalized = normalize(payload.as_object()).unwrap();
        assert_eq!(normalized.len(), 10);
        assert_eq!(normalized["contentBase64"], "YQ==");
        payload["contentSha256"] = "b".repeat(64).into();
        assert!(normalize(payload.as_object()).is_err());
    }
}
