use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

use serde_json::Value;

use super::{MaintenanceStatus, error};
use crate::{cognition::CognitionResult, js_date};

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

pub(super) fn read(root: &Path, now: i64) -> CognitionResult<MaintenanceState> {
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
                Err(_) => return Err(error("memory_health_read_failed")),
            }
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            if value.get("phase").and_then(Value::as_str) != Some("summary") {
                continue;
            }
            let Some(timestamp) = value.get("ts").and_then(Value::as_str) else {
                continue;
            };
            let failed_phases = value
                .pointer("/metrics/failed_phases")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let record = SummaryLine {
                sequence,
                timestamp: timestamp.to_owned(),
                timestamp_ms: js_date::parse_date_millis(timestamp, &Some),
                status: value
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                failed_phases,
            };
            sequence = sequence.saturating_add(1);
            retain_latest_two(&mut latest_two, record);
        }
    }
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
    if matches!(latest.status.as_deref(), Some("error" | "aborted_budget")) {
        return Ok(MaintenanceState {
            status: MaintenanceStatus::Failed,
            last_run_at,
            failed_phases: latest.failed_phases.clone(),
            diagnostics: vec!["memory maintenance failed".into()],
        });
    }
    if latest
        .timestamp_ms
        .is_some_and(|last_run| now.saturating_sub(last_run) > STALE_AFTER_MS)
    {
        return Ok(MaintenanceState {
            status: MaintenanceStatus::Stale,
            last_run_at,
            failed_phases: Vec::new(),
            diagnostics: vec!["memory maintenance is stale".into()],
        });
    }
    if latest.status.as_deref() == Some("ok")
        && previous
            .is_some_and(|line| matches!(line.status.as_deref(), Some("error" | "aborted_budget")))
    {
        return Ok(MaintenanceState {
            status: MaintenanceStatus::Repaired,
            last_run_at,
            failed_phases: Vec::new(),
            diagnostics: vec!["memory maintenance recovered after a previous failure".into()],
        });
    }
    Ok(MaintenanceState {
        status: MaintenanceStatus::Ok,
        last_run_at,
        failed_phases: Vec::new(),
        diagnostics: Vec::new(),
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
