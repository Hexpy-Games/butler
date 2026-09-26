//! Durable owner writes for explicit rules and reviewed task outcomes.

mod task;

pub(crate) use task::ingest_task_outcome_memory;

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

#[derive(Clone, Debug, Default)]
pub(crate) struct ExplicitMemoryUpdateInput {
    pub text: String,
    pub operation_id: Option<String>,
    pub record_id: Option<String>,
    pub project_id: Option<String>,
    pub conversation_session_id: Option<String>,
    pub conversation_message_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExplicitMemoryUpdateResult {
    pub path: PathBuf,
    pub record_id: String,
    pub revision: String,
    pub operation_id: String,
    pub replayed: bool,
    pub job_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TaskMemoryIngestionResult {
    pub task_id: String,
    pub memory_path: PathBuf,
    pub origin_session_id: Option<String>,
    pub origin_event_id: Option<String>,
    pub job_id: String,
}

pub(crate) fn update_explicit_memory(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    publisher: &CompletionPublisher,
    input: &ExplicitMemoryUpdateInput,
) -> CognitionResult<ExplicitMemoryUpdateResult> {
    if crate::public_text::trim_js_whitespace(&input.text).is_empty() {
        return Err(error("explicit_memory_text_required"));
    }
    let memory_root = environment.memory_root(data_root);
    let rules_root = memory_root.join("rules");
    let operation_id = input
        .operation_id
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let record_id = input
        .record_id
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| sha256(format!("explicit-rule:{operation_id}").as_bytes()));
    validate_record_id(&record_id)?;
    let text_path = rules_root.join(format!("{record_id}.md"));
    let binding_path = rules_root.join(format!("{record_id}.source.json"));
    let index_path = rules_root.join("INDEX.md");
    let queue_path = memory_root.join("queue/sync.jsonl");
    let queue_coordination_path = queue_path.with_extension("jsonl.coord.sqlite");
    ensure_data_authority(
        data_root,
        &[
            &rules_root,
            &text_path,
            &binding_path,
            &index_path,
            &queue_path,
            &queue_coordination_path,
        ],
    )?;

    let content_hash = sha256(input.text.as_bytes());
    let revision = explicit_rule_revision(
        &record_id,
        &content_hash,
        input.project_id.as_deref(),
        input.conversation_session_id.as_deref(),
        input.conversation_message_id.as_deref(),
    )?;
    let prior = read_binding(&memory_root, &record_id)?;
    let replayed = if let Some(operation) = prior.as_ref().and_then(|binding| {
        binding
            .operations
            .iter()
            .find(|item| item.operation_id == operation_id)
    }) {
        if operation.revision != revision {
            return Err(error("memory_source_operation_conflict"));
        }
        if read_explicit_record(&memory_root, &record_id)?.is_none() {
            return Err(error("memory_source_operation_retracted"));
        }
        true
    } else {
        false
    };

    if !replayed {
        let observed_at = publisher.now_iso();
        let binding = ExplicitRuleBinding {
            schema: "butler.explicit-rule-binding.v1".into(),
            state: "active".into(),
            record_id: record_id.clone(),
            revision: revision.clone(),
            operation_id: operation_id.clone(),
            content_hash: content_hash.clone(),
            project_id: input.project_id.clone(),
            conversation_session_id: input.conversation_session_id.clone(),
            conversation_message_id: input.conversation_message_id.clone(),
            observed_at,
            operations: prior
                .as_ref()
                .map(|binding| binding.operations.clone())
                .unwrap_or_default()
                .into_iter()
                .chain(std::iter::once(RuleOperation {
                    operation_id: operation_id.clone(),
                    revision: revision.clone(),
                    state: "written".into(),
                }))
                .collect(),
        };
        fs::create_dir_all(&rules_root).map_err(io_error)?;
        write_atomic(&text_path, input.text.as_bytes())?;
        let mut encoded = serde_json::to_vec_pretty(&binding).map_err(json_error)?;
        encoded.push(b'\n');
        write_atomic(&binding_path, &encoded)?;
    }

    let index_text = match fs::read_to_string(&index_path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => String::new(),
    };
    let file_name = format!("{record_id}.md");
    if !index_text.contains(&format!("]({file_name})")) {
        fs::create_dir_all(&rules_root).map_err(io_error)?;
        append_durable(
            &index_path,
            format!("- [{}]({file_name})\n", compact(&input.text, 80)).as_bytes(),
        )?;
    }
    let notice = TypedMemorySourceNotice::ExplicitRule {
        record_id: record_id.clone(),
        revision: revision.clone(),
        operation_id: operation_id.clone(),
    };
    let job_id = publisher.publish_typed_source(&notice)?;
    Ok(ExplicitMemoryUpdateResult {
        path: text_path,
        record_id,
        revision,
        operation_id,
        replayed,
        job_id,
    })
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
    let encoded = crate::json::stringify(&value).map_err(json_error)?;
    Ok(sha256(encoded.as_bytes()))
}

fn compact(value: &str, limit: usize) -> String {
    let collapsed = crate::json::Utf16Prefix::new(value, usize::MAX)
        .collapse_whitespace(crate::public_text::is_js_whitespace);
    if collapsed.len_utf16() <= limit {
        return collapsed.utf8_for_hash().into_owned();
    }
    let text = collapsed.utf8_for_hash();
    format!(
        "{}...",
        crate::json::Utf16Slice::new(&text, 0, limit).utf8_lossy()
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
        return Err(error("explicit_memory_record_id_invalid"));
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> CognitionResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| error("memory_data_path_unsafe"))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| error("memory_data_path_unsafe"))?;
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
        .ok_or_else(|| error("memory_data_path_unsafe"))?;
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

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn io_error(error: std::io::Error) -> CognitionError {
    CognitionError::new("memory_source_unavailable", error.to_string())
}

fn json_error(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_source_unavailable", error.to_string())
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
