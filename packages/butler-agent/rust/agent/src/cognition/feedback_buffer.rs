//! Bounded, read-only access to the canonical feedback buffer.

mod operator;
mod quality_operator;
mod resolve;
mod targets;

pub(crate) use targets::FeedbackTarget;

use std::{
    collections::HashSet,
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::Arc,
};

use indexmap::IndexMap;

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult},
    coordination::CognitionWriteCoordinator,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FeedbackStatus {
    Active,
    Applied,
    Discarded,
    Superseded,
    NeedsClarification,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FeedbackPriority {
    Critical,
    High,
    Normal,
    Low,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FeedbackPrivacyClass {
    Public,
    Private,
    Sensitive,
    Secret,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FeedbackEntry {
    pub(crate) feedback_id: String,
    pub(crate) status: FeedbackStatus,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) priority: FeedbackPriority,
    pub(crate) scope: String,
    pub(crate) category: String,
    pub(crate) target_ref: String,
    pub(crate) promotion_target: String,
    pub(crate) review_after: String,
    pub(crate) expires_at: Option<String>,
    pub(crate) supersedes: Vec<String>,
    pub(crate) conflicts_with: Vec<String>,
    pub(crate) privacy_class: FeedbackPrivacyClass,
    pub(crate) text: String,
    pub(crate) extra_fields: IndexMap<String, String>,
}

impl FeedbackEntry {
    fn is_active_at(&self, now_epoch_ms: i64) -> bool {
        self.status == FeedbackStatus::Active
            && self.expires_at.as_deref().is_none_or(|value| {
                crate::js_date::parse_date_millis(value, &Some)
                    .is_none_or(|expires| expires > now_epoch_ms)
            })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct FeedbackCounts {
    pub(crate) total_count: usize,
    pub(crate) status_active_count: usize,
    pub(crate) active_count: usize,
    pub(crate) active_profile_candidate_count: usize,
}

pub(crate) struct FeedbackBufferService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
}

impl FeedbackBufferService {
    pub(crate) fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
    ) -> Self {
        Self {
            data_root,
            paths,
            coordinator,
        }
    }

    pub(crate) fn counts(&self, now_epoch_ms: i64) -> CognitionResult<FeedbackCounts> {
        let path = self
            .paths
            .cognition_root(&self.data_root)
            .join("feedback/feedback.md");
        count_feedback_file(&path, now_epoch_ms)
    }

    pub(crate) async fn matching_ids(
        &self,
        ids: HashSet<String>,
    ) -> CognitionResult<HashSet<String>> {
        if ids.is_empty() {
            return Ok(HashSet::new());
        }
        let path = self
            .paths
            .cognition_root(&self.data_root)
            .join("feedback/feedback.md");
        tokio::task::spawn_blocking(move || matching_ids_in_file(&path, &ids))
            .await
            .map_err(|_| error("memory_feedback_buffer_read_failed"))?
    }
}

fn matching_ids_in_file(path: &Path, ids: &HashSet<String>) -> CognitionResult<HashSet<String>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(_) => return Err(error("memory_feedback_buffer_read_failed")),
    };
    let mut reader = BufReader::new(file);
    let mut found = HashSet::new();
    while let Some(line) = read_line(&mut reader)? {
        if let Some(heading) = line.bytes.strip_prefix(b"## ") {
            let heading = String::from_utf8_lossy(heading);
            if let Some(id) = crate::public_text::trim_js_whitespace(&heading)
                .split(crate::public_text::is_js_whitespace)
                .find(|value| !value.is_empty())
                && id.starts_with("fb_")
                && ids.contains(id)
            {
                found.insert(id.to_owned());
                if found.len() == ids.len() {
                    break;
                }
            }
        }
    }
    Ok(found)
}

fn count_feedback_file(path: &Path, now_epoch_ms: i64) -> CognitionResult<FeedbackCounts> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FeedbackCounts::default());
        }
        Err(_) => return Err(error("memory_feedback_buffer_read_failed")),
    };

    let fallback_iso = crate::js_date::format_iso_millis(now_epoch_ms)
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into());
    let mut reader = BufReader::new(file);
    let mut record = Vec::new();
    let mut has_record = false;
    let mut counts = FeedbackCounts::default();

    while let Some(line) = read_line(&mut reader)? {
        if line.bytes.starts_with(b"## ") {
            if has_record {
                add_record(&record, &fallback_iso, now_epoch_ms, &mut counts);
                record.clear();
            }
            has_record = true;
            append_line(&mut record, &line.bytes[3..], line.terminated);
        } else {
            has_record = true;
            append_line(&mut record, &line.bytes, line.terminated);
        }
    }
    if has_record {
        add_record(&record, &fallback_iso, now_epoch_ms, &mut counts);
    }
    Ok(counts)
}

struct Line {
    bytes: Vec<u8>,
    terminated: bool,
}

fn read_line(reader: &mut impl BufRead) -> CognitionResult<Option<Line>> {
    let mut bytes = Vec::new();
    let mut terminated = false;
    loop {
        let (count, has_newline) = {
            let available = reader
                .fill_buf()
                .map_err(|_| error("memory_feedback_buffer_read_failed"))?;
            if available.is_empty() {
                break;
            }
            let count = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(available.len(), |position| position + 1);
            let has_newline = available[count - 1] == b'\n';
            bytes.extend_from_slice(&available[..count]);
            (count, has_newline)
        };
        reader.consume(count);
        if has_newline {
            terminated = true;
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            break;
        }
    }

    if bytes.is_empty() && !terminated {
        return Ok(None);
    }
    Ok(Some(Line { bytes, terminated }))
}

fn append_line(record: &mut Vec<u8>, bytes: &[u8], terminated: bool) {
    record.extend_from_slice(bytes);
    if terminated {
        record.push(b'\n');
    }
}

fn add_record(raw: &[u8], fallback_iso: &str, now_epoch_ms: i64, counts: &mut FeedbackCounts) {
    let block = String::from_utf8_lossy(raw);
    if crate::public_text::trim_js_whitespace(&block).is_empty() {
        return;
    }
    let entry = parse_entry(&block, fallback_iso);
    counts.total_count += 1;
    if entry.status == FeedbackStatus::Active {
        counts.status_active_count += 1;
    }
    if entry.is_active_at(now_epoch_ms) {
        counts.active_count += 1;
        if entry.promotion_target == "profile_candidate" {
            counts.active_profile_candidate_count += 1;
        }
    }
}

fn parse_entry(block: &str, fallback_iso: &str) -> FeedbackEntry {
    let mut lines = block.split('\n');
    let heading = lines.next().unwrap_or_default();
    let mut heading = crate::public_text::trim_js_whitespace(heading)
        .split(crate::public_text::is_js_whitespace)
        .filter(|value| !value.is_empty());
    let raw_id = heading.next().unwrap_or_default();
    let feedback_id = if raw_id.starts_with("fb_") {
        raw_id.to_owned()
    } else {
        format!("fb_{}", uuid::Uuid::new_v4())
    };
    let status = match heading.next().unwrap_or_default() {
        "active" => FeedbackStatus::Active,
        "applied" => FeedbackStatus::Applied,
        "discarded" => FeedbackStatus::Discarded,
        "superseded" => FeedbackStatus::Superseded,
        _ => FeedbackStatus::NeedsClarification,
    };

    let mut fields = IndexMap::<String, String>::new();
    let mut body = Vec::new();
    let mut in_body = false;
    for line in lines {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let field = line
            .strip_prefix("- ")
            .and_then(|line| line.split_once(':'))
            .filter(|(key, _)| {
                !key.is_empty()
                    && key
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
            });
        if !in_body && let Some((key, value)) = field {
            fields.insert(
                key.to_owned(),
                crate::public_text::trim_js_whitespace_start(value).to_owned(),
            );
            continue;
        }
        if !crate::public_text::trim_js_whitespace(line).is_empty() || in_body {
            in_body = true;
            body.push(line);
        }
    }

    let get = |key: &str, default: &str| {
        fields
            .get(key)
            .cloned()
            .unwrap_or_else(|| default.to_owned())
    };
    let created_at = get("created_at", fallback_iso);
    let updated_at = fields
        .get("updated_at")
        .or_else(|| fields.get("created_at"))
        .cloned()
        .unwrap_or_else(|| fallback_iso.to_owned());
    let priority = match fields.get("priority").map(String::as_str) {
        Some("critical") => FeedbackPriority::Critical,
        Some("normal") => FeedbackPriority::Normal,
        Some("low") => FeedbackPriority::Low,
        _ => FeedbackPriority::High,
    };
    let privacy_class = match fields.get("privacy_class").map(String::as_str) {
        Some("public") => FeedbackPrivacyClass::Public,
        Some("sensitive") => FeedbackPrivacyClass::Sensitive,
        Some("secret") => FeedbackPrivacyClass::Secret,
        _ => FeedbackPrivacyClass::Private,
    };
    let expires_at = fields
        .get("expires_at")
        .filter(|value| !value.is_empty() && value.as_str() != "null")
        .cloned();
    FeedbackEntry {
        feedback_id,
        status,
        created_at: created_at.clone(),
        updated_at,
        priority,
        scope: get("scope", "global"),
        category: get("category", "unrouted"),
        target_ref: get("target_ref", "unknown"),
        promotion_target: get("promotion_target", "discard"),
        review_after: fields
            .get("review_after")
            .or_else(|| fields.get("created_at"))
            .cloned()
            .unwrap_or_else(|| fallback_iso.to_owned()),
        expires_at,
        supersedes: parse_list(fields.get("supersedes").map(String::as_str)),
        conflicts_with: parse_list(fields.get("conflicts_with").map(String::as_str)),
        privacy_class,
        text: crate::public_text::trim_js_whitespace(&body.join("\n")).to_owned(),
        extra_fields: fields,
    }
}

fn parse_list(value: Option<&str>) -> Vec<String> {
    let Some(value) = value.filter(|value| !value.is_empty() && *value != "[]") else {
        return Vec::new();
    };
    match serde_json::from_str(value) {
        Ok(serde_json::Value::Array(values)) => return values.iter().map(js_string).collect(),
        Ok(_) => return Vec::new(),
        Err(_) => {}
    }
    value
        .split(',')
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn js_string(value: &serde_json::Value) -> String {
    use serde_json::Value;
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, "Could not read the bounded feedback buffer")
}

#[cfg(test)]
#[path = "feedback_buffer/tests.rs"]
mod tests;
