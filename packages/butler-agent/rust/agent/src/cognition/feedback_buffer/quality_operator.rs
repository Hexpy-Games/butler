use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::cognition::{
    CognitionError, CognitionResult, CompletionPublisher, MemorySourceCandidate,
    NativeMemorySourceReference, mutable_paths,
};

use super::{FeedbackBufferService, operator::read_entries};

#[derive(Serialize)]
struct FeedbackOwnerRevision<'a> {
    feedback_id: &'a str,
    created_at: &'a str,
    scope: &'a str,
    category: &'a str,
    target_ref: &'a str,
    text: &'a str,
}

impl FeedbackBufferService {
    pub(crate) async fn operator_quality_exclusion(
        &self,
        feedback_id: &str,
        operation_id: &str,
        source_ref: &str,
        scope: &str,
        publisher: CompletionPublisher,
    ) -> CognitionResult<Value> {
        if scope != "all_user_sessions" || !source_ref.starts_with("memory-source:v2:") {
            return Err(error("invalid_scope"));
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

fn record_exclusion(input: ExclusionOperation<'_>) -> CognitionResult<Value> {
    let ExclusionOperation {
        data_root,
        paths,
        feedback_path,
        feedback_id,
        operation_id,
        source_ref,
        scope,
        publisher,
    } = input;
    let operation_path = feedback_path
        .parent()
        .ok_or_else(|| error("memory_quality_operation_write_failed"))?
        .join("quality-operations.jsonl");
    let operations = read_operations(&operation_path)?;
    let prior = operations
        .iter()
        .find(|operation| operation["operation_id"] == operation_id)
        .cloned();
    let owners = read_entries(feedback_path)?;
    let owner = owners.iter().find(|entry| entry.feedback_id == feedback_id);
    if owner.is_none() && prior.is_none() {
        return Err(error("memory_feedback_entry_not_found"));
    }

    let memory_root = paths.memory_root(data_root);
    let active_descriptor_path = memory_root.join("active-generation.json");
    let quality_guard = [memory_root.as_path(), active_descriptor_path.as_path()];
    mutable_paths::ensure_data_authority(data_root, &quality_guard)?;
    let resolved = NativeMemorySourceReference::new(data_root.to_owned(), paths.clone()).resolve(
        source_ref,
        |candidate: &MemorySourceCandidate| {
            candidate.source_kind == "task_report"
                || candidate.source_kind == "explicit_record"
                || matches!(
                    candidate.origin_kind.as_str(),
                    "user_input" | "assistant_public"
                )
        },
    )?;
    let expected = json!({
        "schema": "butler.memory-source-quality-operation.v1",
        "feedback_id": feedback_id,
        "operation_id": operation_id,
        "intent": "exclude",
        "actor": "operator",
        "source_ref": resolved.source_id.clone(),
        "source_revision": resolved.revision.clone(),
        "source_hash": resolved.source_hash.clone(),
        "generation_id": resolved.generation_id.clone(),
        "episode_id": resolved.episode_id.clone(),
        "target_revision": resolved.revision.clone(),
        "feedback_owner_revision": prior
            .as_ref()
            .and_then(|operation| operation["feedback_owner_revision"].as_str().map(str::to_owned))
            .or_else(|| owner.map(owner_revision)),
        "scope": scope,
    });
    if expected["feedback_owner_revision"].as_str().is_none() {
        return Err(error("memory_quality_target_changed"));
    }
    let mut replayed = false;
    let operation = if let Some(prior) = prior {
        if !same_operation(&prior, &expected) {
            return Err(error("memory_quality_operation_conflict"));
        }
        replayed = true;
        prior
    } else {
        let mut operation = expected;
        operation["status"] = json!("pending");
        operation["created_at"] = json!(now_iso());
        append_operation(&operation_path, &operations, &operation)?;
        operation
    };
    if !replayed {
        publisher.publish_feedback_quality_exclusion(
            feedback_id,
            operation_id,
            operation["source_revision"].as_str().unwrap_or_default(),
        )?;
    }
    let mut result = operation
        .as_object()
        .cloned()
        .ok_or_else(|| error("memory_quality_operation_invalid"))?;
    result.insert("replayed".into(), json!(replayed));
    Ok(Value::Object(result))
}

fn read_operations(path: &Path) -> CognitionResult<Vec<Value>> {
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(error("memory_quality_operation_read_failed")),
    };
    Ok(source
        .lines()
        .filter_map(|line| {
            let value: Value = serde_json::from_str(line).ok()?;
            (value["schema"] == "butler.memory-source-quality-operation.v1").then_some(value)
        })
        .collect())
}

fn append_operation(path: &Path, previous: &[Value], operation: &Value) -> CognitionResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| error("memory_quality_operation_write_failed"))?;
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
        let mut file = options
            .open(&temporary)
            .map_err(|_| error("memory_quality_operation_write_failed"))?;
        for value in previous.iter().chain(std::iter::once(operation)) {
            serde_json::to_writer(&mut file, value)
                .map_err(|_| error("memory_quality_operation_write_failed"))?;
            file.write_all(b"\n")
                .map_err(|_| error("memory_quality_operation_write_failed"))?;
        }
        file.sync_all()
            .map_err(|_| error("memory_quality_operation_write_failed"))?;
        fs::rename(&temporary, path).map_err(|_| error("memory_quality_operation_write_failed"))?;
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| error("memory_quality_operation_write_failed"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

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
    let owner = FeedbackOwnerRevision {
        feedback_id: &entry.feedback_id,
        created_at: &entry.created_at,
        scope: &entry.scope,
        category: &entry.category,
        target_ref: &entry.target_ref,
        text: &entry.text,
    };
    let bytes = serde_json::to_vec(&owner).expect("feedback owner projection is serializable");
    format!("{:x}", Sha256::digest(bytes))
}

fn create_private_dir(path: &Path) -> CognitionResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => return Ok(()),
            Ok(_) => return Err(error("memory_quality_operation_path_unsafe")),
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error("memory_quality_operation_write_failed")),
        }
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(path)
            .map_err(|_| error("memory_quality_operation_write_failed"))
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path).map_err(|_| error("memory_quality_operation_write_failed"))
    }
}

fn now_iso() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    crate::js_date::format_iso_millis(millis)
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned())
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
