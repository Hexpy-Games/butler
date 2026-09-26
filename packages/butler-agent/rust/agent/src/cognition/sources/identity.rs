use serde_json::Value;
use sha2::{Digest, Sha256};

use super::types::CognitionSourceError;

pub(in crate::cognition) fn projection_hash(
    values: Vec<Value>,
) -> Result<String, CognitionSourceError> {
    let json = crate::json::stringify(&Value::Array(values)).map_err(|error| {
        CognitionSourceError::new("cognition_source_json_error", error.to_string())
    })?;
    Ok(sha256(json.as_bytes()))
}

pub(super) fn recovered_parts_hash(
    message: &crate::conversation::ConversationMessageWithParts,
) -> Result<String, CognitionSourceError> {
    let mut json = String::from("[");
    for (index, part) in message.parts.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push('[');
        json.push_str(&serde_json::to_string(&part.id).map_err(json_error)?);
        json.push(',');
        json.push_str(&crate::json::stringify(&part.content_json).map_err(json_error)?);
        json.push(']');
    }
    json.push(']');
    Ok(sha256(json.as_bytes()))
}

fn json_error(error: impl std::fmt::Display) -> CognitionSourceError {
    CognitionSourceError::new("cognition_source_json_error", error.to_string())
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
