use sha2::{Digest, Sha256};

use super::types::CognitionSourceError;
use crate::cognition::CognitionCode;

/// SHA-256 of the `JSON.stringify` form of `parts` (a tuple or array), the
/// identity hash of every projection record.
pub(in crate::cognition) fn projection_hash(
    parts: &(impl serde::Serialize + ?Sized),
) -> Result<String, CognitionSourceError> {
    let value = serde_json::to_value(parts).map_err(json_error)?;
    let json = butler_core::json::stringify(&value).map_err(json_error)?;
    Ok(sha256(json.as_bytes()))
}

pub(super) fn recovered_parts_hash(
    message: &butler_turn::conversation::ConversationMessageWithParts,
) -> Result<String, CognitionSourceError> {
    let mut json = String::from("[");
    for (index, part) in message.parts.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push('[');
        json.push_str(&serde_json::to_string(&part.id).map_err(json_error)?);
        json.push(',');
        json.push_str(&butler_core::json::stringify(&part.content_json).map_err(json_error)?);
        json.push(']');
    }
    json.push(']');
    Ok(sha256(json.as_bytes()))
}

fn json_error(error: impl std::error::Error + Send + Sync + 'static) -> CognitionSourceError {
    crate::cognition::CognitionError::new(
        CognitionCode::CognitionSourceJsonError,
        error.to_string(),
    )
    .with_source(error)
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
