//! Projection-only active feedback snapshot for KnowHow revision.

use std::{fs::File, io::BufReader, path::Path};

use crate::cognition::CognitionResult;

use super::{FeedbackBufferService, append_line, error, parse_entry, read_line};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FeedbackTarget {
    pub feedback_id: String,
    pub category: String,
    pub promotion_target: String,
    pub target_ref: String,
}

impl FeedbackBufferService {
    pub(crate) async fn active_targets(
        &self,
        now_epoch_ms: i64,
    ) -> CognitionResult<Vec<FeedbackTarget>> {
        let path = self
            .paths
            .cognition_root(&self.data_root)
            .join("feedback/feedback.md");
        tokio::task::spawn_blocking(move || active_targets_in_file(&path, now_epoch_ms))
            .await
            .map_err(|_| error("memory_feedback_buffer_read_failed"))?
    }
}

fn active_targets_in_file(path: &Path, now_epoch_ms: i64) -> CognitionResult<Vec<FeedbackTarget>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(error("memory_feedback_buffer_read_failed")),
    };
    let fallback_iso = crate::js_date::format_iso_millis(now_epoch_ms)
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into());
    let mut reader = BufReader::new(file);
    let mut record = Vec::new();
    let mut started = false;
    let mut targets = Vec::new();
    while let Some(line) = read_line(&mut reader)? {
        if line.bytes.starts_with(b"## ") {
            if started {
                push_active_target(&record, &fallback_iso, now_epoch_ms, &mut targets);
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
        push_active_target(&record, &fallback_iso, now_epoch_ms, &mut targets);
    }
    Ok(targets)
}

fn push_active_target(
    record: &[u8],
    fallback_iso: &str,
    now_epoch_ms: i64,
    targets: &mut Vec<FeedbackTarget>,
) {
    let block = String::from_utf8_lossy(record);
    if crate::public_text::trim_js_whitespace(&block).is_empty() {
        return;
    }
    let entry = parse_entry(&block, fallback_iso);
    if entry.is_active_at(now_epoch_ms) {
        targets.push(FeedbackTarget {
            feedback_id: entry.feedback_id,
            category: entry.category,
            promotion_target: entry.promotion_target,
            target_ref: entry.target_ref,
        });
    }
}
