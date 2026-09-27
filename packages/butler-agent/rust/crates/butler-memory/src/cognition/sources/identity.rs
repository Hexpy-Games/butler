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

/// What versions an episode revision besides its scalars.
pub(super) enum RevisionTail {
    /// The recovered-parts hash of a standalone message.
    SourceHash(String),
    /// The outcome generation of a turn; a non-finite one hashes as `null`.
    Generation(f64),
}

impl serde::Serialize for RevisionTail {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::SourceHash(hash) => serializer.serialize_str(hash),
            Self::Generation(generation) => match serde_json::Number::from_f64(*generation) {
                Some(number) => number.serialize(serializer),
                None => serializer.serialize_none(),
            },
        }
    }
}

/// The hashed parts of an episode revision: a marker, each scalar's
/// message, part, pointer and hash, then the tail.
struct EpisodeRevision<'a> {
    scalars: &'a [butler_turn::conversation::ConversationScalar<'a>],
    tail: &'a RevisionTail,
}

impl serde::Serialize for EpisodeRevision<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut parts = serializer.serialize_seq(Some(2 + self.scalars.len() * 4))?;
        parts.serialize_element("episode-revision")?;
        for scalar in self.scalars {
            parts.serialize_element(&scalar.message.message.id)?;
            parts.serialize_element(&scalar.part.id)?;
            parts.serialize_element(&scalar.pointer)?;
            parts.serialize_element(&scalar.hash)?;
        }
        parts.serialize_element(self.tail)?;
        parts.end()
    }
}

/// The revision id of an episode made of `scalars`.
pub(super) fn episode_revision(
    scalars: &[butler_turn::conversation::ConversationScalar<'_>],
    tail: &RevisionTail,
) -> Result<String, CognitionSourceError> {
    projection_hash(&EpisodeRevision { scalars, tail })
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
