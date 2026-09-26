//! Read-only transcript activity fallback for status and usage projections.

use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

const MAX_TOOL_KEYS: usize = 512;
const MAX_DELIVERY_FAILURES: usize = 4_096;
const MAX_DELIVERY_ERROR_CHARS: usize = 2_048;
const DELIVERY_FAILURE_WINDOW_MS: i64 = 24 * 60 * 60 * 1_000;
const MAX_JSONL_LINE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct StatusTranscriptToolUsageBucket {
    pub(crate) calls: u64,
    pub(crate) results: u64,
    pub(crate) successes: u64,
    pub(crate) failures: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct StatusTranscriptActivity {
    pub(crate) tools: StatusTranscriptToolUsageBucket,
    pub(crate) by_tool: BTreeMap<String, StatusTranscriptToolUsageBucket>,
    pub(crate) delivery_failed: u64,
    pub(crate) last_delivery_error: Option<String>,
}

#[derive(Default)]
struct ActivityAccumulator {
    summary: StatusTranscriptActivity,
    delivery_failures: Vec<DeliveryFailure>,
    delivery_unknown_count: u64,
    delivery_unknown_last_error: Option<String>,
    delivery_overflow_count: u64,
    delivery_overflow_latest_ms: Option<i64>,
}

#[derive(Clone)]
struct DeliveryFailure {
    timestamp_ms: i64,
    error: Option<String>,
}

pub(crate) fn read_status_transcript_activity(
    data_root: &Path,
) -> Result<StatusTranscriptActivity, String> {
    read_status_transcript_activity_at(data_root, unix_now_ms())
}

fn read_status_transcript_activity_at(
    data_root: &Path,
    now_ms: i64,
) -> Result<StatusTranscriptActivity, String> {
    let directory = data_root.join("transcripts");
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StatusTranscriptActivity::default());
        }
        Err(_) => return Err("transcript_directory_unavailable".into()),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| "transcript_directory_unavailable".to_owned())?;
        if entry.file_name().to_string_lossy().ends_with(".jsonl") {
            paths.push(entry.path());
        }
    }

    let mut activity = ActivityAccumulator::default();
    for path in paths {
        match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("transcript_metadata_unavailable".into()),
        }
        scan_transcript(&path, &mut activity)?;
    }
    activity.prune(now_ms);
    Ok(activity.summary)
}

fn scan_transcript(path: &Path, activity: &mut ActivityAccumulator) -> Result<(), String> {
    let file = File::open(path).map_err(|_| "transcript_read_unavailable".to_owned())?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader
            .fill_buf()
            .map_err(|_| "transcript_read_unavailable".to_owned())?;
        if available.is_empty() {
            break;
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            append_line(&mut line, &mut oversized, &available[..newline]);
            reader.consume(newline + 1);
            if !oversized {
                apply_activity_line(activity, &line);
            }
            line.clear();
            oversized = false;
        } else {
            append_line(&mut line, &mut oversized, available);
            let consumed = available.len();
            reader.consume(consumed);
        }
    }
    Ok(())
}

fn append_line(line: &mut Vec<u8>, oversized: &mut bool, part: &[u8]) {
    if *oversized {
        return;
    }
    if line.len().saturating_add(part.len()) > MAX_JSONL_LINE_BYTES {
        line.clear();
        *oversized = true;
        return;
    }
    line.extend_from_slice(part);
}

fn apply_activity_line(activity: &mut ActivityAccumulator, bytes: &[u8]) {
    let line = String::from_utf8_lossy(bytes);
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    if let Ok(event) = serde_json::from_str::<Value>(line) {
        activity.apply_event(&event);
    }
}

impl ActivityAccumulator {
    fn apply_event(&mut self, event: &Value) {
        let kind = event.get("kind").and_then(Value::as_str);
        let payload = event.get("payload");
        if matches!(kind, Some("tool_call" | "tool_result")) {
            let name = payload
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty());
            if let Some(name) = name {
                let ok = !payload
                    .and_then(|value| value.get("ok"))
                    .is_some_and(|value| value == false);
                self.add_tool(name, kind == Some("tool_call"), ok);
            }
        }
        if kind != Some("delivery")
            || !payload
                .and_then(|value| value.get("ok"))
                .is_some_and(|value| value == false)
        {
            return;
        }
        let error = payload
            .and_then(|value| value.get("error"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|error| !error.is_empty())
            .map(truncate_error);
        let timestamp = event
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(crate::js_date::parse_iso_millis);
        let Some(timestamp_ms) = timestamp else {
            self.delivery_unknown_count = self.delivery_unknown_count.saturating_add(1);
            if error.is_some() {
                self.delivery_unknown_last_error = error;
            }
            return;
        };
        self.insert_delivery_failure(DeliveryFailure {
            timestamp_ms,
            error,
        });
    }

    fn add_tool(&mut self, name: &str, is_call: bool, ok: bool) {
        let key = if self.summary.by_tool.contains_key(name)
            || self.summary.by_tool.len() < MAX_TOOL_KEYS
        {
            name
        } else {
            "__other__"
        };
        let bucket = self.summary.by_tool.entry(key.to_owned()).or_default();
        if is_call {
            self.summary.tools.calls = self.summary.tools.calls.saturating_add(1);
            bucket.calls = bucket.calls.saturating_add(1);
        } else {
            self.summary.tools.results = self.summary.tools.results.saturating_add(1);
            bucket.results = bucket.results.saturating_add(1);
            if ok {
                self.summary.tools.successes = self.summary.tools.successes.saturating_add(1);
                bucket.successes = bucket.successes.saturating_add(1);
            } else {
                self.summary.tools.failures = self.summary.tools.failures.saturating_add(1);
                bucket.failures = bucket.failures.saturating_add(1);
            }
        }
    }

    fn insert_delivery_failure(&mut self, failure: DeliveryFailure) {
        let insertion = self
            .delivery_failures
            .partition_point(|current| current.timestamp_ms <= failure.timestamp_ms);
        self.delivery_failures.insert(insertion, failure);
        if self.delivery_failures.len() > MAX_DELIVERY_FAILURES {
            let removed = self.delivery_failures.remove(0);
            self.delivery_overflow_count = self.delivery_overflow_count.saturating_add(1);
            self.delivery_overflow_latest_ms = Some(
                self.delivery_overflow_latest_ms
                    .map_or(removed.timestamp_ms, |latest| {
                        latest.max(removed.timestamp_ms)
                    }),
            );
        }
    }

    fn prune(&mut self, now_ms: i64) {
        let cutoff = now_ms.saturating_sub(DELIVERY_FAILURE_WINDOW_MS);
        self.delivery_failures
            .retain(|failure| failure.timestamp_ms >= cutoff);
        if self
            .delivery_overflow_latest_ms
            .is_some_and(|latest| latest < cutoff)
        {
            self.delivery_overflow_count = 0;
            self.delivery_overflow_latest_ms = None;
        }
        self.summary.delivery_failed = self
            .delivery_unknown_count
            .saturating_add(self.delivery_failures.len() as u64)
            .saturating_add(
                if self
                    .delivery_overflow_latest_ms
                    .is_some_and(|latest| latest >= cutoff)
                {
                    self.delivery_overflow_count
                } else {
                    0
                },
            );
        self.summary.last_delivery_error = self.delivery_unknown_last_error.clone().or_else(|| {
            self.delivery_failures
                .last()
                .and_then(|failure| failure.error.clone())
        });
    }
}

fn truncate_error(error: &str) -> String {
    error.chars().take(MAX_DELIVERY_ERROR_CHARS).collect()
}

fn unix_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().min(i64::MAX as u128) as i64
        })
}

#[cfg(test)]
mod tests;
