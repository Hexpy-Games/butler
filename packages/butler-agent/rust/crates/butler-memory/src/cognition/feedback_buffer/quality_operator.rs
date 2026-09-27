//! Operator quality exclusions of memory sources, recorded beside the
//! feedback buffer and replayed idempotently by operation id.

use crate::lenient::JsonField;
use crate::lenient::set_field;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::cognition::CognitionCode;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::cognition::{
    CognitionError, CognitionResult, CompletionPublisher, MemorySourceCandidate,
    MemorySourceReference, mutable_paths,
};

use super::{FeedbackBufferService, operator::read_entries};

impl FeedbackBufferService {
    pub async fn operator_quality_exclusion(
        &self,
        feedback_id: &str,
        operation_id: &str,
        source_ref: &str,
        scope: &str,
        publisher: CompletionPublisher,
    ) -> CognitionResult<Value> {
        if scope != "all_user_sessions" || !source_ref.starts_with("memory-source:v2:") {
            return Err(error(CognitionCode::InvalidScope));
        }
        let data_root = self.data_root.clone();
        let memory_root = self.paths.memory_root(&data_root);
        let queue_path = memory_root.join("queue/sync.jsonl");
        mutable_paths::ensure_data_authority(&data_root, &[&memory_root, &queue_path])?;
        let feedback_id = feedback_id.to_owned();
        let operation_id = operation_id.to_owned();
        let source_ref = source_ref.to_owned();
        let scope = scope.to_owned();
        let paths = self.paths.clone();
        self.mutate("feedback_quality_exclusion", move |feedback_path| {
            record_exclusion(ExclusionOperation {
                data_root: &data_root,
                paths: &paths,
                feedback_path: &feedback_path,
                feedback_id: &feedback_id,
                operation_id: &operation_id,
                source_ref: &source_ref,
                scope: &scope,
                publisher: &publisher,
            })
        })
        .await
    }
}

#[derive(Clone, Copy)]
struct ExclusionOperation<'a> {
    data_root: &'a Path,
    paths: &'a crate::cognition::CognitionPathEnvironment,
    feedback_path: &'a Path,
    feedback_id: &'a str,
    operation_id: &'a str,
    source_ref: &'a str,
    scope: &'a str,
    publisher: &'a CompletionPublisher,
}

/// Records (or replays) an operator exclusion of a memory source and
/// publishes it for the projection; the stored operation with `replayed`.
fn record_exclusion(input: ExclusionOperation<'_>) -> CognitionResult<Value> {
    let operation_path = input
        .feedback_path
        .parent()
        .ok_or_else(|| error(CognitionCode::MemoryQualityOperationWriteFailed))?
        .join("quality-operations.jsonl");
    let operations = read_operations(&operation_path)?;
    let prior = operations
        .iter()
        .find(|operation| operation["operation_id"] == input.operation_id)
        .cloned();
    let owners = read_entries(input.feedback_path)?;
    let owner = owners
        .iter()
        .find(|entry| entry.feedback_id == input.feedback_id);
    if owner.is_none() && prior.is_none() {
        return Err(error(CognitionCode::MemoryFeedbackEntryNotFound));
    }
    let expected = expected_operation(input, prior.as_ref(), owner)?;
    if expected.field("feedback_owner_revision").as_str().is_none() {
        return Err(error(CognitionCode::MemoryQualityTargetChanged));
    }
    let (operation, replayed) = if let Some(prior) = prior {
        if !same_operation(&prior, &expected) {
            return Err(error(CognitionCode::MemoryQualityOperationConflict));
        }
        (prior, true)
    } else {
        let mut operation = expected;
        set_field(&mut operation, "status", json!("pending"));
        set_field(&mut operation, "created_at", json!(now_iso()));
        append_operation(&operation_path, &operations, &operation)?;
        input.publisher.publish_feedback_quality_exclusion(
            input.feedback_id,
            input.operation_id,
            operation
                .field("source_revision")
                .as_str()
                .unwrap_or_default(),
        )?;
        (operation, false)
    };
    let mut result = operation
        .as_object()
        .cloned()
        .ok_or_else(|| error(CognitionCode::MemoryQualityOperationInvalid))?;
    result.insert("replayed".into(), json!(replayed));
    Ok(Value::Object(result))
}

/// The operation this request describes: the source it resolves to now,
/// and the feedback owner revision of the prior operation or the owner.
fn expected_operation(
    input: ExclusionOperation<'_>,
    prior: Option<&Value>,
    owner: Option<&super::FeedbackEntry>,
) -> CognitionResult<Value> {
    let memory_root = input.paths.memory_root(input.data_root);
    let active_descriptor_path = memory_root.join("active-generation.json");
    let quality_guard = [memory_root.as_path(), active_descriptor_path.as_path()];
    mutable_paths::ensure_data_authority(input.data_root, &quality_guard)?;
    let resolved = MemorySourceReference::new(input.data_root.to_owned(), input.paths.clone())
        .resolve(input.source_ref, |candidate: &MemorySourceCandidate| {
            candidate.source_kind == "task_report"
                || candidate.source_kind == "explicit_record"
                || matches!(
                    candidate.origin_kind.as_str(),
                    "user_input" | "assistant_public"
                )
        })?;
    Ok(json!({
        "schema": "butler.memory-source-quality-operation.v1",
        "feedback_id": input.feedback_id,
        "operation_id": input.operation_id,
        "intent": "exclude",
        "actor": "operator",
        "source_ref": resolved.source_id.clone(),
        "source_revision": resolved.revision.clone(),
        "source_hash": resolved.source_hash.clone(),
        "generation_id": resolved.generation_id.clone(),
        "episode_id": resolved.episode_id.clone(),
        "target_revision": resolved.revision.clone(),
        "feedback_owner_revision": prior
            .and_then(|operation| operation["feedback_owner_revision"].as_str().map(str::to_owned))
            .or_else(|| owner.map(owner_revision)),
        "scope": input.scope,
    }))
}

fn read_operations(path: &Path) -> CognitionResult<Vec<Value>> {
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(error(CognitionCode::MemoryQualityOperationReadFailed)),
    };
    Ok(source
        .lines()
        .filter_map(|line| {
            let value: Value = serde_json::from_str(line).ok()?;
            (value.field("schema") == "butler.memory-source-quality-operation.v1").then_some(value)
        })
        .collect())
}

/// Rewrites the operation log with `operation` appended. Passthrough: the
/// stored operations are written back as they were read.
fn append_operation(
    path: &Path,
    previous: &[Value],
    operation: &impl Serialize,
) -> CognitionResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| error(CognitionCode::MemoryQualityOperationWriteFailed))?;
    create_private_dir(parent)?;
    let temporary = parent.join(format!(
        "quality-operations.jsonl.tmp-{}",
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
        let mut file = options.open(&temporary).map_err(|source| {
            error(CognitionCode::MemoryQualityOperationWriteFailed).with_source(source)
        })?;
        let operation = serde_json::to_value(operation).map_err(|source| {
            error(CognitionCode::MemoryQualityOperationWriteFailed).with_source(source)
        })?;
        for value in previous.iter().chain(std::iter::once(&operation)) {
            serde_json::to_writer(&mut file, value).map_err(|source| {
                error(CognitionCode::MemoryQualityOperationWriteFailed).with_source(source)
            })?;
            file.write_all(b"\n").map_err(|source| {
                error(CognitionCode::MemoryQualityOperationWriteFailed).with_source(source)
            })?;
        }
        file.sync_all().map_err(|source| {
            error(CognitionCode::MemoryQualityOperationWriteFailed).with_source(source)
        })?;
        fs::rename(&temporary, path).map_err(|source| {
            error(CognitionCode::MemoryQualityOperationWriteFailed).with_source(source)
        })?;
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|source| {
                error(CognitionCode::MemoryQualityOperationWriteFailed).with_source(source)
            })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

/// Whether a stored operation describes the same exclusion.
fn same_operation(prior: &Value, expected: &Value) -> bool {
    [
        "feedback_id",
        "operation_id",
        "intent",
        "actor",
        "source_ref",
        "source_revision",
        "source_hash",
        "generation_id",
        "episode_id",
        "target_revision",
        "feedback_owner_revision",
        "scope",
    ]
    .into_iter()
    .all(|field| prior[field] == expected[field])
}

fn owner_revision(entry: &super::FeedbackEntry) -> String {
    // Same fields and order as `cognition::feedback::FeedbackOwnerRevision`, so
    // revisions computed here match the feedback owner's.
    let owner = serde_json::json!({
        "feedback_id": entry.feedback_id,
        "created_at": entry.created_at,
        "scope": entry.scope,
        "category": entry.category,
        "target_ref": entry.target_ref,
        "text": entry.text,
    });
    format!("{:x}", Sha256::digest(owner.to_string()))
}

fn create_private_dir(path: &Path) -> CognitionResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => return Ok(()),
            Ok(_) => return Err(error(CognitionCode::MemoryQualityOperationPathUnsafe)),
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error(CognitionCode::MemoryQualityOperationWriteFailed)),
        }
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder.create(path).map_err(|source| {
            error(CognitionCode::MemoryQualityOperationWriteFailed).with_source(source)
        })
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path)
            .map_err(|source| error("memory_quality_operation_write_failed").with_source(source))
    }
}

fn now_iso() -> String {
    let millis = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128),
    )
    .unwrap_or(i64::MAX);
    butler_core::js_date::format_iso_millis(millis)
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned())
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
