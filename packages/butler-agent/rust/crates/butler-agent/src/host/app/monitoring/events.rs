//! System-event projection over existing scheduler and consolidation files.

use std::{fs, path::Path, time::SystemTime};

use serde_json::{Value, json};

use super::now_iso;
use crate::gateway::AppMonitorPage;

const SCHEDULER_JOBS: [(&str, &str); 3] = [
    ("session-sync", "Session sync"),
    ("context-maintenance", "Context maintenance"),
    ("consolidation-cycle", "Consolidation cycle"),
];
const PROFILE_METRICS: [&str; 12] = [
    "profiling_enabled",
    "mode",
    "candidate_count",
    "promoted_count",
    "skipped_count",
    "stable_entry_count",
    "projection_written",
    "transcript_scanned_file_count",
    "transcript_scanned_event_count",
    "transcript_captured_candidate_count",
    "transcript_extractor_model_called",
    "transcript_extractor_fallback_used",
];

pub(super) fn read(root: &Path, page: AppMonitorPage) -> Value {
    let mut events = SCHEDULER_JOBS
        .iter()
        .map(|(id, title)| scheduler_event(root, id, title))
        .collect::<Vec<_>>();
    events.extend(consolidation_events(root));
    events.sort_by(|left, right| event_time(right).cmp(event_time(left)));
    let total = events.len();
    let limit = page.limit.unwrap_or(20).clamp(1, 100);
    let offset = page.offset.unwrap_or(0);
    let visible = events
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    json!({
        "events": visible,
        "pagination": { "limit": limit, "offset": offset, "total": total, "has_more": offset.saturating_add(limit) < total },
        "generated_at": now_iso(), "raw_text_included": false,
    })
}

fn scheduler_event(root: &Path, id: &str, title: &str) -> Value {
    let state = read_json(&root.join("state/scheduler").join(format!("{id}.json")));
    let mut metrics = vec![metric("job_id", &json!(id))];
    push_metric(&mut metrics, "last_run_date", state.get("lastRunDate"));
    let mut event = json!({
        "id": format!("scheduler:{id}"), "kind": "scheduler_job", "title": title,
        "status": string(state.get("status")).unwrap_or("not_run".into()),
        "metrics": metrics, "raw_text_included": false,
    });
    if let Some(at) = string(state.get("lastRunAt")) {
        event["occurred_at"] = json!(at);
    }
    event
}

fn consolidation_events(root: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(root.join("cognition/consolidation/runs")) else {
        return Vec::new();
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|extension| extension.to_str()) == Some("json"))
        .filter_map(|path| {
            let modified = fs::metadata(&path)
                .ok()?
                .modified()
                .unwrap_or(SystemTime::UNIX_EPOCH);
            Some((path, modified))
        })
        .collect::<Vec<_>>();
    paths.sort_by(|left, right| right.1.cmp(&left.1));
    paths
        .into_iter()
        .take(8)
        .flat_map(|(path, _)| run_events(&path))
        .collect()
}

fn run_events(path: &Path) -> Vec<Value> {
    let run = read_json(path);
    let Some(id) = string(run.get("run_id")) else {
        return Vec::new();
    };
    let phases = run
        .get("phases")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let failed = phases
        .iter()
        .filter(|phase| string(phase.get("status")).as_deref() != Some("ok"))
        .count();
    let started = string(run.get("started_at"));
    let completed = string(run.get("completed_at"));
    let occurred = completed.clone().or_else(|| started.clone());
    let metrics = vec![
        metric("phase_count", &json!(phases.len())),
        metric("failed_phase_count", &json!(failed)),
        metric(
            "raw_text_included",
            &json!(run.get("raw_text_included") == Some(&Value::Bool(true))),
        ),
    ];
    let mut event = json!({
        "id": format!("consolidation:{id}"), "kind": "consolidation_run",
        "title": "Consolidation cycle", "status": string(run.get("status")).unwrap_or("unknown".into()),
        "metrics": metrics, "raw_text_included": false,
    });
    set_timestamps(
        &mut event,
        occurred.as_deref(),
        started.as_deref(),
        completed.as_deref(),
    );
    if let Some(duration) = started
        .as_deref()
        .zip(completed.as_deref())
        .and_then(|(start, end)| duration_ms(start, end))
    {
        event["duration_ms"] = json!(duration);
    }
    let Some(profile) = phases
        .iter()
        .find(|phase| string(phase.get("phase")).as_deref() == Some("profile_consolidation"))
    else {
        return vec![event];
    };
    let mut metrics = Vec::new();
    if let Some(values) = profile.get("metrics").filter(|value| value.is_object()) {
        for key in PROFILE_METRICS {
            push_metric(&mut metrics, key, values.get(key));
        }
        if values.get("raw_text_included").is_some() {
            push_metric(
                &mut metrics,
                "raw_text_included",
                values.get("raw_text_included"),
            );
        }
    }
    let mut profile_event = json!({
        "id": format!("consolidation:{id}:profile"), "kind": "profile_consolidation",
        "title": "Profile consolidation",
        "status": string(profile.get("status")).or_else(|| string(run.get("status"))).unwrap_or("unknown".into()),
        "metrics": metrics, "raw_text_included": false,
    });
    if let Some(values) = profile.get("metrics") {
        if let Some(model) = string(values.get("transcript_extractor_model")) {
            profile_event["model_ref"] = json!(model);
        }
        if let Some(uses) = values
            .get("transcript_extractor_uses_butler_model")
            .and_then(Value::as_bool)
        {
            profile_event["uses_butler_model"] = json!(uses);
        }
    }
    if let Some(duration) = started
        .as_deref()
        .zip(completed.as_deref())
        .and_then(|(start, end)| duration_ms(start, end))
    {
        profile_event["duration_ms"] = json!(duration);
    }
    set_timestamps(
        &mut profile_event,
        occurred.as_deref(),
        started.as_deref(),
        completed.as_deref(),
    );
    vec![event, profile_event]
}

fn read_json(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| json!({}))
}

fn string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
}

fn metric(label: &str, value: &Value) -> Value {
    json!({ "label": label, "value": value })
}

fn push_metric(metrics: &mut Vec<Value>, label: &str, value: Option<&Value>) {
    if let Some(value) =
        value.filter(|value| value.is_string() || value.is_number() || value.is_boolean())
    {
        metrics.push(metric(label, &value.clone()));
    }
}

fn set_timestamps(
    event: &mut Value,
    occurred: Option<&str>,
    started: Option<&str>,
    completed: Option<&str>,
) {
    for (key, value) in [
        ("occurred_at", occurred),
        ("started_at", started),
        ("completed_at", completed),
    ] {
        if let Some(value) = value {
            event[key] = json!(value);
        }
    }
}

fn event_time(event: &Value) -> &str {
    event
        .get("occurred_at")
        .or_else(|| event.get("completed_at"))
        .or_else(|| event.get("started_at"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn duration_ms(start: &str, end: &str) -> Option<u64> {
    let start = chrono::DateTime::parse_from_rfc3339(start)
        .ok()?
        .timestamp_millis();
    let end = chrono::DateTime::parse_from_rfc3339(end)
        .ok()?
        .timestamp_millis();
    Some(u64::try_from(end.saturating_sub(start).max(0)).unwrap_or_default())
}
