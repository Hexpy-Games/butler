//! Source-compatible applied transition over the canonical feedback.md file.

use std::{
    fs::{self, File, OpenOptions},
    future::Future,
    io::{BufReader, Write},
    path::Path,
    pin::Pin,
};

use crate::{
    cognition::{CognitionError, CognitionResult, mutable_paths},
    coordination::{CognitionWaitClass, CognitionWriteAcquire},
};

use super::{
    FeedbackBufferService, FeedbackEntry, FeedbackStatus, append_line, error, parse_entry,
    read_line,
};

const STANDARD_FIELDS: [&str; 12] = [
    "created_at",
    "updated_at",
    "priority",
    "scope",
    "category",
    "target_ref",
    "promotion_target",
    "review_after",
    "expires_at",
    "supersedes",
    "conflicts_with",
    "privacy_class",
];

impl FeedbackBufferService {
    pub(crate) async fn resolve_applied(&self, id: &str) -> CognitionResult<()> {
        let cognition_root = self.paths.cognition_root(&self.data_root);
        let path = cognition_root.join("feedback/feedback.md");
        let lock_path = self.paths.consolidation_lock(&self.data_root);
        mutable_paths::ensure_data_authority(
            &self.data_root,
            &[&cognition_root, &path, &lock_path],
        )?;
        let lease = self
            .coordinator
            .acquire(
                CognitionWriteAcquire::immediate(lock_path, "feedback_resolve"),
                CognitionWaitClass::Background,
            )
            .await
            .map_err(|failure| CognitionError::new(failure.code, failure.message))?
            .ok_or_else(|| error("memory_write_busy"))?;
        let id = id.to_owned();
        let now_ms =
            chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now()).timestamp_millis();
        tokio::task::spawn_blocking(move || {
            let result = rewrite_resolved(&path, &id, now_ms);
            let released = lease
                .release(result.is_ok())
                .map_err(|failure| CognitionError::new(failure.code, failure.message));
            match (result, released) {
                (Err(error), _) => Err(error),
                (Ok(_), Err(error)) => Err(error),
                (Ok(()), Ok(())) => Ok(()),
            }
        })
        .await
        .map_err(|_| error("memory_feedback_buffer_write_failed"))?
    }
}

impl crate::cognition::FeedbackResolvePort for FeedbackBufferService {
    fn resolve_applied<'a>(
        &'a self,
        id: &'a str,
    ) -> Pin<Box<dyn Future<Output = CognitionResult<()>> + Send + 'a>> {
        Box::pin(FeedbackBufferService::resolve_applied(self, id))
    }
}

fn rewrite_resolved(path: &Path, id: &str, now_ms: i64) -> CognitionResult<()> {
    let source = File::open(path).map_err(|_| error("memory_feedback_buffer_read_failed"))?;
    let mut reader = BufReader::new(source);
    let parent = path
        .parent()
        .ok_or_else(|| error("memory_feedback_buffer_write_failed"))?;
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
            .map_err(|_| error("memory_feedback_buffer_write_failed"))?;
        let fallback_iso = crate::js_date::format_iso_millis(now_ms)
            .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into());
        let mut record = Vec::new();
        let mut started = false;
        let mut found = false;
        while let Some(line) = read_line(&mut reader)? {
            if line.bytes.starts_with(b"## ") {
                if started {
                    write_record(&mut output, &record, id, &fallback_iso, &mut found)?;
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
            write_record(&mut output, &record, id, &fallback_iso, &mut found)?;
        }
        if !found {
            return Err(error("memory_feedback_entry_not_found"));
        }
        output
            .sync_all()
            .map_err(|_| error("memory_feedback_buffer_write_failed"))?;
        fs::rename(&temporary, path).map_err(|_| error("memory_feedback_buffer_write_failed"))?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| error("memory_feedback_buffer_write_failed"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn write_record(
    output: &mut File,
    raw: &[u8],
    id: &str,
    now_iso: &str,
    found: &mut bool,
) -> CognitionResult<()> {
    let block = String::from_utf8_lossy(raw);
    if crate::public_text::trim_js_whitespace(&block).is_empty() {
        return Ok(());
    }
    let mut entry = parse_entry(&block, now_iso);
    if !*found && entry.feedback_id == id {
        entry.status = FeedbackStatus::Applied;
        entry.updated_at = now_iso.to_owned();
        *found = true;
    }
    output
        .write_all(format_entry(&entry).as_bytes())
        .map_err(|_| error("memory_feedback_buffer_write_failed"))
}

pub(super) fn format_entry(entry: &FeedbackEntry) -> String {
    let mut lines = vec![
        format!("## {} {}", entry.feedback_id, status_name(entry.status)),
        String::new(),
        format!("- created_at: {}", entry.created_at),
        format!("- updated_at: {}", entry.updated_at),
        format!("- priority: {}", priority_name(entry.priority)),
        format!("- scope: {}", entry.scope),
        format!("- category: {}", entry.category),
        format!("- target_ref: {}", entry.target_ref),
        format!("- promotion_target: {}", entry.promotion_target),
        format!("- review_after: {}", entry.review_after),
        format!(
            "- expires_at: {}",
            entry.expires_at.as_deref().unwrap_or("null")
        ),
        format!(
            "- supersedes: {}",
            serde_json::to_string(&entry.supersedes).unwrap()
        ),
        format!(
            "- conflicts_with: {}",
            serde_json::to_string(&entry.conflicts_with).unwrap()
        ),
        format!("- privacy_class: {}", privacy_name(entry.privacy_class)),
    ];
    lines.extend(
        entry
            .extra_fields
            .iter()
            .filter(|(key, _)| !STANDARD_FIELDS.contains(&key.as_str()))
            .map(|(key, value)| format!("- {key}: {value}")),
    );
    lines.push(String::new());
    lines.push(crate::public_text::trim_js_whitespace(&entry.text).to_owned());
    lines.push(String::new());
    format!("{}\n", lines.join("\n"))
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

fn priority_name(priority: super::FeedbackPriority) -> &'static str {
    match priority {
        super::FeedbackPriority::Critical => "critical",
        super::FeedbackPriority::High => "high",
        super::FeedbackPriority::Normal => "normal",
        super::FeedbackPriority::Low => "low",
    }
}

fn privacy_name(privacy: super::FeedbackPrivacyClass) -> &'static str {
    match privacy {
        super::FeedbackPrivacyClass::Public => "public",
        super::FeedbackPrivacyClass::Private => "private",
        super::FeedbackPrivacyClass::Sensitive => "sensitive",
        super::FeedbackPrivacyClass::Secret => "secret",
    }
}
