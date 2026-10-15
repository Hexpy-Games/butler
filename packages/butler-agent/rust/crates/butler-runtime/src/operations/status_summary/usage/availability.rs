//! Read-only web-search and transcript availability projections.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::super::stream::unsigned_count;
use super::UsageMonitor;

pub(super) fn read_web_search(
    data_root: &Path,
    since_ts: Option<f64>,
    now: f64,
    monitor: &UsageMonitor,
) -> Value {
    if since_ts.is_none() {
        let metrics = read_json(&data_root.join("runtime/web-search-metrics.json"));
        return json!({
            "requestCount": unsigned_count(metrics.get("requestCount")).unwrap_or(0),
            "lastProvider": metrics.get("lastProvider").and_then(Value::as_str),
            "lastError": metrics.get("lastError").and_then(Value::as_str)
        });
    }
    monitor
        .searches
        .lock()
        .read(data_root, since_ts.unwrap_or_default(), now)
}

/// What the monitor says about its transcript scan when it did not scan
/// (or scanned only one session).
fn degraded_activity() -> Value {
    json!({ "status": "degraded", "reason": "read_only_transcript_activity_fallback" })
}

pub(super) fn read_tools(
    data_root: &Path,
    session_id: Option<&str>,
    since_ts: Option<f64>,
    now: f64,
    monitor: &UsageMonitor,
) -> (Value, Value, Value) {
    if let Some(since) = since_ts {
        let path = session_id.map(|id| session_transcript_path(data_root, id));
        let activity =
            monitor
                .transcripts
                .lock()
                .read_window(data_root, path.as_deref(), since, now);
        return match activity {
            Ok(activity) => (
                activity_tools(&activity),
                degraded_activity(),
                json!({"status":"available","reason":null}),
            ),
            Err(_) => (
                json!({"calls":null,"results":null,"successes":null,"failures":null,"byTool":{}}),
                degraded_activity(),
                json!({"status":"unavailable","reason":"transcript_read_failed"}),
            ),
        };
    }
    if let Some(session_id) = session_id {
        return (
            read_session_tools(data_root, session_id, monitor),
            degraded_activity(),
            json!({"status":"available","reason":null}),
        );
    }
    let transcript_activity = monitor.transcript_activity(data_root);
    if transcript_activity.facts["available"] == true {
        return (
            json!({ "calls": transcript_activity.facts["tools"]["calls"], "results": transcript_activity.facts["tools"]["results"], "successes": transcript_activity.facts["tools"]["successes"], "failures": transcript_activity.facts["tools"]["failures"], "byTool": transcript_activity.facts.get("byTool").cloned().unwrap_or_else(|| json!({})) }),
            transcript_activity.status.clone(),
            json!({ "status": "available", "reason": null }),
        );
    }
    (
        json!({ "calls": null, "results": null, "successes": null, "failures": null, "byTool": {} }),
        transcript_activity.status.clone(),
        transcript_activity.status.clone(),
    )
}

/// `transcripts/<session id>.jsonl`, the id reduced to file-name characters.
fn session_transcript_path(data_root: &Path, session_id: &str) -> PathBuf {
    let safe = session_id
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || "._-".contains(ch) {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    data_root.join("transcripts").join(format!("{safe}.jsonl"))
}

/// A session's all-time tool usage from the per-file activity cache.
fn read_session_tools(data_root: &Path, session_id: &str, monitor: &UsageMonitor) -> Value {
    let path = session_transcript_path(data_root, session_id);
    let Some(activity) = monitor.file_activity(&path) else {
        return empty_tools();
    };
    activity_tools(&activity)
}

fn activity_tools(activity: &crate::context::StatusTranscriptActivity) -> Value {
    let by_tool: serde_json::Map<String, Value> = activity
        .by_tool
        .iter()
        .map(|(name, bucket)| (name.clone(), tool_bucket(bucket)))
        .collect();
    let mut tools = tool_bucket(&activity.tools);
    butler_core::json::object_mut(&mut tools).insert("byTool".into(), Value::Object(by_tool));
    tools
}

fn tool_bucket(bucket: &crate::context::StatusTranscriptToolUsageBucket) -> Value {
    json!({"calls":bucket.calls,"results":bucket.results,
        "successes":bucket.successes,"failures":bucket.failures})
}

fn empty_tools() -> Value {
    json!({"calls":0,"results":0,"successes":0,"failures":0,"byTool":{}})
}

fn read_json(path: &Path) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| json!({}))
}
