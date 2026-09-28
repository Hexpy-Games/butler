//! Named operator reads and mutations over the canonical feedback buffer.

use crate::cognition::CognitionCode;
use std::{
    fs::{self, File},
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
    /// Every feedback entry, for the operator.
    pub async fn operator_entries(&self) -> CognitionResult<Vec<Value>> {
        let data_root = self.data_root.clone();
        let path = feedback_path(self);
        mutable_paths::ensure_data_authority(&data_root, &[&path])?;
        tokio::task::spawn_blocking(move || {
            read_entries(&path).map(|entries| entries.iter().map(entry_value).collect())
        })
        .await
        .map_err(|source| {
            operator_error(CognitionCode::MemoryFeedbackBufferReadFailed).with_source(source)
        })?
    }

    /// The entry with `id`, when it exists.
    pub async fn operator_read(&self, id: &str) -> CognitionResult<Option<Value>> {
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
        .map_err(|source| {
            operator_error(CognitionCode::MemoryFeedbackBufferReadFailed).with_source(source)
        })?
    }

    /// Adds a feedback entry; the stored entry.
    pub async fn operator_add(
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

    /// Sets the status of the entry with `id`; the updated entry.
    pub async fn operator_resolve(&self, id: &str, status: &str) -> CognitionResult<Value> {
        let next_status = match status {
            "applied" => FeedbackStatus::Applied,
            "discarded" => FeedbackStatus::Discarded,
            "superseded" => FeedbackStatus::Superseded,
            "needs_clarification" => FeedbackStatus::NeedsClarification,
            _ => return Err(operator_error(CognitionCode::MemoryFeedbackStatusInvalid)),
        };
        let id = id.to_owned();
        let now = now_iso();
        self.mutate("feedback_resolve", move |path| {
            let mut entries = read_entries(&path)?;
            let entry = entries
                .iter_mut()
                .find(|entry| entry.feedback_id == id)
                .ok_or_else(|| operator_error(CognitionCode::MemoryFeedbackEntryNotFound))?;
            entry.status = next_status;
            entry.updated_at = now;
            let result = entry_value(entry);
            write_entries(&path, &entries)?;
            Ok(result)
        })
        .await
    }

    /// Removes resolved entries; how many were removed and kept.
    pub async fn operator_clear_resolved(&self) -> CognitionResult<(usize, usize)> {
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
            .map_err(CognitionError::from)?
            .ok_or_else(|| operator_error(CognitionCode::MemoryWriteBusy))?;
        tokio::task::spawn_blocking(move || {
            let result = operation(path);
            let released = lease.release(result.is_ok()).map_err(CognitionError::from);
            match (result, released) {
                (Err(error), _) | (Ok(_), Err(error)) => Err(error),
                (Ok(value), Ok(())) => Ok(value),
            }
        })
        .await
        .map_err(|source| {
            operator_error(CognitionCode::MemoryFeedbackBufferWriteFailed).with_source(source)
        })?
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
        Err(_) => {
            return Err(operator_error(
                CognitionCode::MemoryFeedbackBufferReadFailed,
            ));
        }
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
            append_line(
                &mut record,
                line.bytes.get(3..).unwrap_or_default(),
                line.terminated,
            );
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
    if butler_core::public_text::trim_js_whitespace(&block).is_empty() {
        return;
    }
    entries.push(parse_entry(&block, fallback_iso));
}

fn write_entries(path: &Path, entries: &[FeedbackEntry]) -> CognitionResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| operator_error(CognitionCode::MemoryFeedbackBufferWriteFailed))?;
    create_private_dir(parent)?;
    butler_platform::secure_fs::replace_private(
        path,
        |output| {
            for (index, entry) in entries.iter().enumerate() {
                if index > 0 {
                    output.write_all(b"\n")?;
                }
                let formatted = format_entry(entry);
                let formatted = formatted.strip_suffix('\n').unwrap_or(&formatted);
                output.write_all(formatted.as_bytes())?;
            }
            Ok(())
        },
        std::convert::identity,
    )
    .map_err(|source| {
        operator_error(CognitionCode::MemoryFeedbackBufferWriteFailed).with_source(source)
    })
}

fn create_private_dir(path: &Path) -> CognitionResult<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    butler_platform::secure_fs::owner_only_dirs(&mut builder);
    builder
        .create(path)
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() {
                Ok(())
            } else {
                Err(error)
            }
        })
        .map_err(|source| {
            operator_error(CognitionCode::MemoryFeedbackBufferWriteFailed).with_source(source)
        })
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

fn operator_error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, "Cognition feedback operator operation failed")
}
