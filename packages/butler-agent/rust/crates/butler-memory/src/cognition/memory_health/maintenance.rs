//! The consolidation maintenance status, read from the run-summary logs.

use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

use serde::Deserialize;
use serde_json::Value;

use super::{MaintenanceStatus, error};
use crate::cognition::{CognitionCode, CognitionResult};
use crate::lenient::{self, Obj};
use butler_core::js_date;

const STALE_AFTER_MS: i64 = 7 * 24 * 60 * 60 * 1_000;

#[derive(Clone, Debug)]
struct SummaryLine {
    sequence: u64,
    timestamp: String,
    timestamp_ms: Option<i64>,
    status: Option<String>,
    failed_phases: Vec<String>,
}

#[derive(Clone, Debug)]
pub(super) struct MaintenanceState {
    pub status: MaintenanceStatus,
    pub last_run_at: Option<String>,
    pub failed_phases: Vec<String>,
    pub diagnostics: Vec<String>,
}

/// The maintenance status from the latest two run summaries.
pub(super) fn read(root: &Path, now: i64) -> CognitionResult<MaintenanceState> {
    let latest_two = latest_summaries(root)?;
    let Some(latest) = latest_two.last() else {
        return Ok(MaintenanceState {
            status: MaintenanceStatus::Missing,
            last_run_at: None,
            failed_phases: Vec::new(),
            diagnostics: vec!["memory maintenance has not run".into()],
        });
    };
    let previous = latest_two.iter().rev().nth(1);
    let last_run_at = Some(latest.timestamp.clone());
    let failed =
        |line: &SummaryLine| matches!(line.status.as_deref(), Some("error" | "aborted_budget"));
    let (status, failed_phases, diagnostic) = if failed(latest) {
        (
            MaintenanceStatus::Failed,
            latest.failed_phases.clone(),
            Some("memory maintenance failed"),
        )
    } else if latest
        .timestamp_ms
        .is_some_and(|last_run| now.saturating_sub(last_run) > STALE_AFTER_MS)
    {
        (
            MaintenanceStatus::Stale,
            Vec::new(),
            Some("memory maintenance is stale"),
        )
    } else if latest.status.as_deref() == Some("ok") && previous.is_some_and(failed) {
        (
            MaintenanceStatus::Repaired,
            Vec::new(),
            Some("memory maintenance recovered after a previous failure"),
        )
    } else {
        (MaintenanceStatus::Ok, Vec::new(), None)
    };
    Ok(MaintenanceState {
        status,
        last_run_at,
        failed_phases,
        diagnostics: diagnostic.into_iter().map(str::to_owned).collect(),
    })
}

/// The two latest `summary` lines of both run-summary logs, oldest first.
fn latest_summaries(root: &Path) -> CognitionResult<Vec<SummaryLine>> {
    let mut latest_two = Vec::with_capacity(2);
    let mut sequence = 0_u64;
    for path in [
        root.join("run-summary.jsonl"),
        root.join("logs/run-summary.jsonl"),
    ] {
        let Ok(file) = File::open(path) else {
            continue;
        };
        let mut reader = BufReader::new(file);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => return Err(error(CognitionCode::MemoryHealthReadFailed)),
            }
            let Some(record) = summary_line(&line, sequence) else {
                continue;
            };
            sequence = sequence.saturating_add(1);
            retain_latest_two(&mut latest_two, record);
        }
    }
    Ok(latest_two)
}

/// A run-summary log line; a field with the wrong type reads as absent.
#[derive(Default, Deserialize)]
#[serde(default)]
struct RawSummary {
    #[serde(deserialize_with = "lenient::option")]
    phase: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    ts: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    status: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    metrics: Option<Obj<RawMetrics>>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct RawMetrics {
    #[serde(deserialize_with = "lenient::string_list")]
    failed_phases: Vec<String>,
}

/// The line when it is a `summary` with a timestamp.
fn summary_line(line: &[u8], sequence: u64) -> Option<SummaryLine> {
    if line.iter().all(u8::is_ascii_whitespace) {
        return None;
    }
    let value = serde_json::from_slice::<Value>(line).ok()?;
    let raw: RawSummary = lenient::view(&value);
    if raw.phase.as_deref() != Some("summary") {
        return None;
    }
    let timestamp = raw.ts?;
    Some(SummaryLine {
        sequence,
        timestamp_ms: js_date::parse_date_millis(&timestamp, &Some),
        timestamp,
        status: raw.status,
        failed_phases: raw
            .metrics
            .map(|metrics| metrics.0.failed_phases)
            .unwrap_or_default(),
    })
}

fn retain_latest_two(records: &mut Vec<SummaryLine>, next: SummaryLine) {
    let position = records
        .iter()
        .position(|current| compare(current, &next).is_gt())
        .unwrap_or(records.len());
    records.insert(position, next);
    if records.len() > 2 {
        records.remove(0);
    }
}

fn compare(left: &SummaryLine, right: &SummaryLine) -> std::cmp::Ordering {
    match (left.timestamp_ms, right.timestamp_ms) {
        (Some(left_ms), Some(right_ms)) => left_ms
            .cmp(&right_ms)
            .then_with(|| left.sequence.cmp(&right.sequence)),
        _ => left.sequence.cmp(&right.sequence),
    }
}
