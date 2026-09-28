//! Durable owner writes for explicit rules and reviewed task outcomes.

mod task;

pub use task::ingest_task_outcome_memory;

use crate::cognition::CognitionCode;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde_json::json;
use sha2::{Digest, Sha256};

use super::{ExplicitRuleBinding, RuleOperation, read_binding, read_explicit_record};
use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult, CompletionPublisher,
    TypedMemorySourceNotice, ensure_data_authority,
};

/// An explicit rule to remember.
#[derive(Clone, Debug, Default)]
pub struct ExplicitMemoryUpdateInput {
    /// Rule text.
    pub text: String,
    /// Idempotency key; a retry with the same id replays the first write.
    pub operation_id: Option<String>,
    /// Rule record id; derived from the operation when absent.
    pub record_id: Option<String>,
    /// Project the rule belongs to.
    pub project_id: Option<String>,
    /// Conversation session the rule came from.
    pub conversation_session_id: Option<String>,
    /// Message the rule came from.
    pub conversation_message_id: Option<String>,
}

/// What an explicit rule update wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExplicitMemoryUpdateResult {
    /// Path of the rule text.
    pub path: PathBuf,
    /// Rule record id.
    pub record_id: String,
    /// Rule revision.
    pub revision: String,
    /// Operation id.
    pub operation_id: String,
    /// The operation had already written this revision.
    pub replayed: bool,
    /// Projection job published for the rule.
    pub job_id: String,
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

/// Writes (or replays) an explicit rule and publishes it for projection.
pub fn update_explicit_memory(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    publisher: &CompletionPublisher,
    input: &ExplicitMemoryUpdateInput,
) -> CognitionResult<ExplicitMemoryUpdateResult> {
    if butler_core::public_text::trim_js_whitespace(&input.text).is_empty() {
        return Err(error(CognitionCode::ExplicitMemoryTextRequired));
    }
    let memory_root = environment.memory_root(data_root);
    let operation_id =
        trimmed(input.operation_id.as_deref()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let record_id = trimmed(input.record_id.as_deref())
        .unwrap_or_else(|| sha256(format!("explicit-rule:{operation_id}").as_bytes()));
    validate_record_id(&record_id)?;
    let paths = RulePaths::new(data_root, &memory_root, &record_id)?;
    let content_hash = sha256(input.text.as_bytes());
    let revision = explicit_rule_revision(
        &record_id,
        &content_hash,
        input.project_id.as_deref(),
        input.conversation_session_id.as_deref(),
        input.conversation_message_id.as_deref(),
    )?;
    let prior = read_binding(&memory_root, &record_id)?;
    let replayed = replayed(
        &memory_root,
        prior.as_ref(),
        &record_id,
        &operation_id,
        &revision,
    )?;
    if !replayed {
        let binding = ExplicitRuleBinding {
            schema: "butler.explicit-rule-binding.v1".into(),
            state: "active".into(),
            record_id: record_id.clone(),
            revision: revision.clone(),
            operation_id: operation_id.clone(),
            content_hash,
            project_id: input.project_id.clone(),
            conversation_session_id: input.conversation_session_id.clone(),
            conversation_message_id: input.conversation_message_id.clone(),
            observed_at: publisher.now_iso(),
            operations: prior
                .map(|binding| binding.operations)
                .unwrap_or_default()
                .into_iter()
                .chain(std::iter::once(RuleOperation {
                    operation_id: operation_id.clone(),
                    revision: revision.clone(),
                    state: "written".into(),
                }))
                .collect(),
        };
        paths.write(&input.text, &binding)?;
    }
    paths.index(&record_id, &input.text)?;
    let notice = TypedMemorySourceNotice::ExplicitRule {
        record_id: record_id.clone(),
        revision: revision.clone(),
        operation_id: operation_id.clone(),
    };
    let job_id = publisher.publish_typed_source(&notice)?;
    Ok(ExplicitMemoryUpdateResult {
        path: paths.text,
        record_id,
        revision,
        operation_id,
        replayed,
        job_id,
    })
}

/// The trimmed value, when not empty.
fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// Whether this operation already wrote this revision; an operation that
/// wrote another revision, or whose record is gone, is refused.
fn replayed(
    memory_root: &Path,
    prior: Option<&ExplicitRuleBinding>,
    record_id: &str,
    operation_id: &str,
    revision: &str,
) -> CognitionResult<bool> {
    let Some(operation) = prior.and_then(|binding| {
        binding
            .operations
            .iter()
            .find(|item| item.operation_id == operation_id)
    }) else {
        return Ok(false);
    };
    if operation.revision != revision {
        return Err(error(CognitionCode::MemorySourceOperationConflict));
    }
    if read_explicit_record(memory_root, record_id)?.is_none() {
        return Err(error(CognitionCode::MemorySourceOperationRetracted));
    }
    Ok(true)
}

/// The files of one explicit rule, checked to stay inside the data root.
struct RulePaths {
    root: PathBuf,
    text: PathBuf,
    binding: PathBuf,
    index: PathBuf,
}

impl RulePaths {
    fn new(data_root: &Path, memory_root: &Path, record_id: &str) -> CognitionResult<Self> {
        let root = memory_root.join("rules");
        let paths = Self {
            text: root.join(format!("{record_id}.md")),
            binding: root.join(format!("{record_id}.source.json")),
            index: root.join("INDEX.md"),
            root,
        };
        let queue_path = memory_root.join("queue/sync.jsonl");
        let queue_coordination_path = queue_path.with_extension("jsonl.coord.sqlite");
        ensure_data_authority(
            data_root,
            &[
                &paths.root,
                &paths.text,
                &paths.binding,
                &paths.index,
                &queue_path,
                &queue_coordination_path,
            ],
        )?;
        Ok(paths)
    }

    /// Writes the rule text and its source binding.
    fn write(&self, text: &str, binding: &ExplicitRuleBinding) -> CognitionResult<()> {
        fs::create_dir_all(&self.root).map_err(io_error)?;
        write_atomic(&self.text, text.as_bytes())?;
        let mut encoded = serde_json::to_vec_pretty(binding).map_err(json_error)?;
        encoded.push(b'\n');
        write_atomic(&self.binding, &encoded)
    }

    /// Lists the rule in `INDEX.md` unless it is already there.
    fn index(&self, record_id: &str, text: &str) -> CognitionResult<()> {
        let index_text = fs::read_to_string(&self.index).unwrap_or_default();
        let file_name = format!("{record_id}.md");
        if index_text.contains(&format!("]({file_name})")) {
            return Ok(());
        }
        fs::create_dir_all(&self.root).map_err(io_error)?;
        append_durable(
            &self.index,
            format!("- [{}]({file_name})\n", compact(text, 80)).as_bytes(),
        )
    }
}

fn explicit_rule_revision(
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

fn compact(value: &str, limit: usize) -> String {
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

fn validate_record_id(value: &str) -> CognitionResult<()> {
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

fn write_atomic(path: &Path, bytes: &[u8]) -> CognitionResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| error(CognitionCode::MemoryDataPathUnsafe))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| error(CognitionCode::MemoryDataPathUnsafe))?;
    let temporary = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(io_error)?;
        file.write_all(bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        fs::rename(&temporary, path).map_err(io_error)?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(io_error)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn append_durable(path: &Path, bytes: &[u8]) -> CognitionResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| error(CognitionCode::MemoryDataPathUnsafe))?;
    let existed = path.exists();
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        .map_err(io_error)?;
    if !existed {
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(io_error)?;
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
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
