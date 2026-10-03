//! Durable owner writes for explicit rules and reviewed task outcomes.

mod task;

pub use task::ingest_task_outcome_memory;

use crate::cognition::CognitionCode;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::cognition::{CognitionError, CognitionResult};

/// An explicit rule to remember.
#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
pub struct ExplicitMemoryUpdateInput {
    /// Requested lifetime: this chat, 7 days, or always (default).
    #[serde(default)]
    pub duration: Option<String>,
    /// Fixed capture expiry; never extended by replay or a busy lease.
    #[serde(default)]
    pub expires_at: Option<String>,
    /// Session ownership, distinct from origin provenance.
    #[serde(default)]
    pub scope_session_id: Option<String>,
    /// Rule text.
    pub text: String,
    /// Idempotency key; a retry with the same id replays the first write.
    pub operation_id: Option<String>,
    /// Project the rule belongs to.
    pub project_id: Option<String>,
    /// Conversation session the rule came from.
    pub conversation_session_id: Option<String>,
    /// Message the rule came from.
    pub conversation_message_id: Option<String>,
}

/// What ingesting a reviewed task outcome wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskMemoryIngestionResult {
    /// Task id.
    pub task_id: String,
    /// Path of the task memory.
    pub memory_path: PathBuf,
    /// Session the task came from.
    pub origin_session_id: Option<String>,
    /// Event the task came from.
    pub origin_event_id: Option<String>,
    /// Projection job published for the task report.
    pub job_id: String,
}

pub(super) fn explicit_rule_revision(
    record_id: &str,
    content_hash: &str,
    project_id: Option<&str>,
    session_id: Option<&str>,
    message_id: Option<&str>,
) -> CognitionResult<String> {
    let value = json!([
        "explicit_record",
        "rule",
        record_id,
        content_hash,
        project_id,
        session_id,
        message_id,
    ]);
    let encoded = butler_core::json::stringify(&value).map_err(json_error)?;
    Ok(sha256(encoded.as_bytes()))
}

pub(super) fn compact(value: &str, limit: usize) -> String {
    let collapsed = butler_core::json::Utf16Prefix::new(value, usize::MAX)
        .collapse_whitespace(butler_core::public_text::is_js_whitespace);
    if collapsed.len_utf16() <= limit {
        return collapsed.utf8_for_hash().into_owned();
    }
    let text = collapsed.utf8_for_hash();
    format!(
        "{}...",
        butler_core::json::Utf16Slice::new(&text, 0, limit).utf8_lossy()
    )
}

pub(super) fn validate_record_id(value: &str) -> CognitionResult<()> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains(['/', '\\', '\0'])
        || matches!(value, "." | "..")
        || path.components().count() != 1
        || path.file_name().and_then(|name| name.to_str()) != Some(value)
    {
        return Err(error(CognitionCode::ExplicitMemoryRecordIdInvalid));
    }
    Ok(())
}

pub(super) fn write_atomic(path: &Path, bytes: &[u8]) -> CognitionResult<()> {
    if path.parent().is_none() || path.file_name().is_none() {
        return Err(error(CognitionCode::MemoryDataPathUnsafe));
    }
    butler_platform::secure_fs::replace_private(
        path,
        |file| file.write_all(bytes).map_err(io_error),
        io_error,
    )
}

fn append_durable(path: &Path, bytes: &[u8]) -> CognitionResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| error(CognitionCode::MemoryDataPathUnsafe))?;
    let existed = path.exists();
    butler_platform::secure_fs::append_private(path)
        .and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        .map_err(io_error)?;
    if !existed {
        butler_platform::secure_fs::sync_path(parent).map_err(io_error)?;
    }
    Ok(())
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn io_error(error: std::io::Error) -> CognitionError {
    CognitionError::new(CognitionCode::MemorySourceUnavailable, error.to_string())
        .with_source(error)
}

fn json_error(error: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(CognitionCode::MemorySourceUnavailable, error.to_string())
        .with_source(error)
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
