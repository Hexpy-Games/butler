//! Named operator reads and mutations over the canonical feedback buffer.

use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value, json};

use crate::{
    cognition::{CognitionError, CognitionResult, mutable_paths},
    coordination::{CognitionWaitClass, CognitionWriteAcquire},
};

use super::{
    FeedbackBufferService, FeedbackEntry, FeedbackPriority, FeedbackPrivacyClass, FeedbackStatus,
    append_line, parse_entry, read_line, resolve::format_entry,
};

impl FeedbackBufferService {
    pub(crate) async fn operator_entries(&self) -> CognitionResult<Vec<Value>> {
        let data_root = self.data_root.clone();
        let path = feedback_path(self);
        mutable_paths::ensure_data_authority(&data_root, &[&path])?;
        tokio::task::spawn_blocking(move || {
            read_entries(&path).map(|entries| entries.iter().map(entry_value).collect())
        })
        .await
        .map_err(|_| operator_error("memory_feedback_buffer_read_failed"))?
    }

    pub(crate) async fn operator_read(&self, id: &str) -> CognitionResult<Option<Value>> {
        let data_root = self.data_root.clone();
        let path = feedback_path(self);
        let id = id.to_owned();
        mutable_paths::ensure_data_authority(&data_root, &[&path])?;
        tokio::task::spawn_blocking(move || {
            read_entries(&path).map(|entries| {
                entries
                    .iter()
                    .find(|entry| entry.feedback_id == id)
                    .map(entry_value)
            })
        })
        .await
        .map_err(|_| operator_error("memory_feedback_buffer_read_failed"))?
    }

    pub(crate) async fn operator_add(
        &self,
        text: String,
        target_ref: String,
        category: String,
        scope: String,
        promotion_target: String,
    ) -> CognitionResult<Value> {
        let now = now_iso();
        self.mutate("feedback_add", move |path| {
            let mut entries = read_entries(&path)?;
            let entry = FeedbackEntry {
                feedback_id: format!("fb_{}", uuid::Uuid::new_v4()),
                status: FeedbackStatus::Active,
                created_at: now.clone(),
                updated_at: now.clone(),
                priority: FeedbackPriority::High,
                scope,
                category,
                target_ref,
                promotion_target,
                review_after: now,
                expires_at: None,
                supersedes: Vec::new(),
                conflicts_with: Vec::new(),
                privacy_class: FeedbackPrivacyClass::Private,
                text,
                extra_fields: Default::default(),
            };
            entries.push(entry.clone());
            write_entries(&path, &entries)?;
            Ok(entry_value(&entry))
        })
        .await
    }

    pub(crate) async fn operator_resolve(&self, id: &str, status: &str) -> CognitionResult<Value> {
        let next_status = match status {
            "applied" => FeedbackStatus::Applied,
            "discarded" => FeedbackStatus::Discarded,
            "superseded" => FeedbackStatus::Superseded,
            "needs_clarification" => FeedbackStatus::NeedsClarification,
            _ => return Err(operator_error("memory_feedback_status_invalid")),
        };
        let id = id.to_owned();
        let now = now_iso();
        self.mutate("feedback_resolve", move |path| {
            let mut entries = read_entries(&path)?;
            let entry = entries
                .iter_mut()
                .find(|entry| entry.feedback_id == id)
                .ok_or_else(|| operator_error("memory_feedback_entry_not_found"))?;
            entry.status = next_status;
            entry.updated_at = now;
            let result = entry_value(entry);
            write_entries(&path, &entries)?;
            Ok(result)
        })
        .await
    }

    pub(crate) async fn operator_clear_resolved(&self) -> CognitionResult<(usize, usize)> {
        self.mutate("feedback_clear", move |path| {
            let entries = read_entries(&path)?;
            let original_count = entries.len();
            let remaining = entries
                .into_iter()
                .filter(|entry| {
                    matches!(
                        entry.status,
                        FeedbackStatus::Active | FeedbackStatus::NeedsClarification
                    )
                })
                .collect::<Vec<_>>();
            let removed = original_count.saturating_sub(remaining.len());
            let remaining_count = remaining.len();
            write_entries(&path, &remaining)?;
            Ok((removed, remaining_count))
        })
        .await
    }

    pub(super) async fn mutate<T, F>(
        &self,
        purpose: &'static str,
        operation: F,
    ) -> CognitionResult<T>
    where
        T: Send + 'static,
        F: FnOnce(PathBuf) -> CognitionResult<T> + Send + 'static,
    {
        let cognition_root = self.paths.cognition_root(&self.data_root);
        let path = cognition_root.join("feedback/feedback.md");
        let quality_path = cognition_root.join("feedback/quality-operations.jsonl");
        let lock_path = self.paths.consolidation_lock(&self.data_root);
        mutable_paths::ensure_data_authority(
            &self.data_root,
            &[&cognition_root, &path, &quality_path, &lock_path],
        )?;
        let lease = self
            .coordinator
            .acquire(
                CognitionWriteAcquire::immediate(lock_path, purpose),
                CognitionWaitClass::Background,
            )
            .await
            .map_err(|failure| CognitionError::new(failure.code, failure.message))?
            .ok_or_else(|| operator_error("memory_write_busy"))?;
        tokio::task::spawn_blocking(move || {
            let result = operation(path);
            let released = lease
                .release(result.is_ok())
                .map_err(|failure| CognitionError::new(failure.code, failure.message));
            match (result, released) {
                (Err(error), _) | (Ok(_), Err(error)) => Err(error),
                (Ok(value), Ok(())) => Ok(value),
            }
        })
        .await
        .map_err(|_| operator_error("memory_feedback_buffer_write_failed"))?
    }
}

fn feedback_path(service: &FeedbackBufferService) -> PathBuf {
    service
        .paths
        .cognition_root(&service.data_root)
        .join("feedback/feedback.md")
}

pub(super) fn read_entries(path: &Path) -> CognitionResult<Vec<FeedbackEntry>> {
    let source = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(operator_error("memory_feedback_buffer_read_failed")),
    };
    let fallback_iso = now_iso();
    let mut reader = std::io::BufReader::new(source);
    let mut record = Vec::new();
    let mut started = false;
    let mut entries = Vec::new();
    while let Some(line) = read_line(&mut reader)? {
        if line.bytes.starts_with(b"## ") {
            if started {
                push_entry(&record, &fallback_iso, &mut entries);
                record.clear();
            }
            started = true;
            append_line(&mut record, &line.bytes[3..], line.terminated);
        } else {
            started = true;
            append_line(&mut record, &line.bytes, line.terminated);
        }
    }
    if started {
        push_entry(&record, &fallback_iso, &mut entries);
    }
    Ok(entries)
}

fn push_entry(record: &[u8], fallback_iso: &str, entries: &mut Vec<FeedbackEntry>) {
    let block = String::from_utf8_lossy(record);
    if crate::public_text::trim_js_whitespace(&block).is_empty() {
        return;
    }
    entries.push(parse_entry(&block, fallback_iso));
}

fn write_entries(path: &Path, entries: &[FeedbackEntry]) -> CognitionResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| operator_error("memory_feedback_buffer_write_failed"))?;
    create_private_dir(parent)?;
    let temporary = parent.join(format!("feedback.md.tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options
            .open(&temporary)
            .map_err(|_| operator_error("memory_feedback_buffer_write_failed"))?;
        for (index, entry) in entries.iter().enumerate() {
            if index > 0 {
                output
                    .write_all(b"\n")
                    .map_err(|_| operator_error("memory_feedback_buffer_write_failed"))?;
            }
            let formatted = format_entry(entry);
            let formatted = formatted.strip_suffix('\n').unwrap_or(&formatted);
            output
                .write_all(formatted.as_bytes())
                .map_err(|_| operator_error("memory_feedback_buffer_write_failed"))?;
        }
        output
            .sync_all()
            .map_err(|_| operator_error("memory_feedback_buffer_write_failed"))?;
        fs::rename(&temporary, path)
            .map_err(|_| operator_error("memory_feedback_buffer_write_failed"))?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| operator_error("memory_feedback_buffer_write_failed"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn create_private_dir(path: &Path) -> CognitionResult<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() {
                Ok(())
            } else {
                Err(error)
            }
        })
        .map_err(|_| operator_error("memory_feedback_buffer_write_failed"))
}

fn entry_value(entry: &FeedbackEntry) -> Value {
    let mut extra_fields = Map::new();
    for (key, value) in &entry.extra_fields {
        extra_fields.insert(key.clone(), Value::String(value.clone()));
    }
    json!({
        "feedback_id": entry.feedback_id,
        "status": status_name(entry.status),
        "created_at": entry.created_at,
        "updated_at": entry.updated_at,
        "priority": priority_name(entry.priority),
        "scope": entry.scope,
        "category": entry.category,
        "target_ref": entry.target_ref,
        "promotion_target": entry.promotion_target,
        "review_after": entry.review_after,
        "expires_at": entry.expires_at,
        "supersedes": entry.supersedes,
        "conflicts_with": entry.conflicts_with,
        "privacy_class": privacy_name(entry.privacy_class),
        "text": entry.text,
        "extra_fields": extra_fields,
    })
}

fn status_name(status: FeedbackStatus) -> &'static str {
    match status {
        FeedbackStatus::Active => "active",
        FeedbackStatus::Applied => "applied",
        FeedbackStatus::Discarded => "discarded",
        FeedbackStatus::Superseded => "superseded",
        FeedbackStatus::NeedsClarification => "needs_clarification",
    }
}

fn priority_name(priority: FeedbackPriority) -> &'static str {
    match priority {
        FeedbackPriority::Critical => "critical",
        FeedbackPriority::High => "high",
        FeedbackPriority::Normal => "normal",
        FeedbackPriority::Low => "low",
    }
}

fn privacy_name(privacy: FeedbackPrivacyClass) -> &'static str {
    match privacy {
        FeedbackPrivacyClass::Public => "public",
        FeedbackPrivacyClass::Private => "private",
        FeedbackPrivacyClass::Sensitive => "sensitive",
        FeedbackPrivacyClass::Secret => "secret",
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn operator_error(code: &'static str) -> CognitionError {
    CognitionError::new(code, "Cognition feedback operator operation failed")
}
