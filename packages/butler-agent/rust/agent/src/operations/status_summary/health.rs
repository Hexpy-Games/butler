//! Read-only operational health projection over existing state files.

use std::{fs, path::Path};

use serde_json::{Value, json};

use crate::context;

use super::stream::unsigned_count;

pub(super) struct TranscriptActivityProjection {
    pub(super) status: Value,
    pub(super) facts: Value,
}

pub(super) fn read_health(
    data_root: &Path,
    transcript_activity: &TranscriptActivityProjection,
) -> Value {
    let mut pending = 0_u64;
    let mut failed = 0_u64;
    let mut delivered = 0_u64;
    let mut last_error = None::<String>;
    let queue_dir = data_root.join("runtime/task-notifications");
    if let Ok(entries) = fs::read_dir(queue_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let notification = read_json(&path);
            match notification.get("status").and_then(Value::as_str) {
                Some("pending") => pending += 1,
                Some("failed") => {
                    failed += 1;
                    if let Some(message) = notification
                        .get("lastError")
                        .and_then(Value::as_str)
                        .filter(|message| !message.trim().is_empty())
                    {
                        last_error = Some(safe_error(message));
                    }
                }
                Some("delivered") => delivered += 1,
                _ => {}
            }
        }
    }
    let task_counts = read_tasks(data_root);
    if last_error.is_none() {
        last_error = transcript_activity
            .facts
            .get("lastDeliveryError")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    let mut web_search = read_json(&data_root.join("runtime/web-search-metrics.json"));
    let page_reader = read_json(&data_root.join("butler.config.json"));
    let reader_backend = env_value("BUTLER_WEB_READER_BACKEND")
        .or_else(|| {
            page_reader
                .pointer("/webSearch/readerBackend")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "lightweight" | "browser" | "firecrawl"
            )
        })
        .unwrap_or_else(|| "lightweight".into())
        .to_ascii_lowercase();
    if !web_search.is_object() {
        web_search = json!({});
    }
    let web_count = unsigned_count(web_search.get("requestCount")).unwrap_or(0);
    let web_provider = web_search
        .get("lastProvider")
        .filter(|value| value.is_string())
        .cloned()
        .unwrap_or(Value::Null);
    let web_error = web_search
        .get("lastError")
        .and_then(Value::as_str)
        .map(safe_error);
    json!({
        "delivery": {
            "pending": pending,
            "failed": failed,
            "delivered": delivered,
            "sessionFailed": transcript_activity
                .facts
                .get("deliveryFailed")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            "lastError": last_error
        },
        "sessionActivity": transcript_activity.status.clone(),
        "tasks": task_counts,
        "webSearch": {
            "requestCount": web_count,
            "lastProvider": web_provider,
            "lastQuery": null,
            "lastError": web_error
        },
        "pageReader": { "backend": reader_backend }
    })
}

pub(super) fn render_health(health: &Value) -> String {
    let mut lines = vec![
        "## Operational Reliability".to_owned(),
        format!(
            "delivery backlog: pending={}, failed={}, delivered={}",
            display(&health["delivery"]["pending"]),
            display(&health["delivery"]["failed"]),
            display(&health["delivery"]["delivered"]),
        ),
        format!(
            "session delivery failures: failed={}",
            display(&health["delivery"]["sessionFailed"])
        ),
    ];
    if health["sessionActivity"]["status"].as_str() != Some("available") {
        let status = health["sessionActivity"]["status"]
            .as_str()
            .unwrap_or("unknown");
        let reason = health["sessionActivity"]["reason"].as_str();
        lines.push(match reason {
            Some(reason) => format!("session activity index: {status} ({reason})"),
            None => format!("session activity index: {status}"),
        });
    }
    if let Some(error) = health["delivery"]["lastError"].as_str() {
        lines.push(format!("delivery last error: {error}"));
    }
    lines.push(format!(
        "task recovery: running={}, recoverable={}, failed={}",
        display(&health["tasks"]["running"]),
        display(&health["tasks"]["recoverable"]),
        display(&health["tasks"]["failed"]),
    ));
    lines.push(format!(
        "web search: requests={}, provider={}",
        display(&health["webSearch"]["requestCount"]),
        health["webSearch"]["lastProvider"]
            .as_str()
            .unwrap_or("none"),
    ));
    lines.push(format!(
        "page reader: backend={}",
        health["pageReader"]["backend"]
            .as_str()
            .unwrap_or("unknown")
    ));
    if let Some(error) = health["webSearch"]["lastError"].as_str() {
        lines.push(format!("web search last error: {error}"));
    }
    lines.join("\n")
}

pub(super) fn read_transcript_activity(data_root: &Path) -> TranscriptActivityProjection {
    match context::read_status_transcript_activity(data_root) {
        Ok(activity) => {
            let status =
                json!({ "status": "degraded", "reason": "read_only_transcript_activity_fallback" });
            let by_tool: serde_json::Map<String, Value> = activity
                .by_tool
                .iter()
                .map(|(name, bucket)| (name.clone(), tool_bucket_value(bucket)))
                .collect();
            let facts = json!({
                "available": true,
                "status": status,
                "tools": tool_bucket_value(&activity.tools),
                "byTool": by_tool,
                "deliveryFailed": activity.delivery_failed,
                "lastDeliveryError": activity.last_delivery_error.as_deref().map(safe_error)
            });
            TranscriptActivityProjection { status, facts }
        }
        Err(reason) => {
            let status = json!({ "status": "unavailable", "reason": reason });
            let facts = json!({ "available": false, "status": status, "tools": null, "deliveryFailed": null, "lastDeliveryError": null });
            TranscriptActivityProjection { status, facts }
        }
    }
}

fn tool_bucket_value(bucket: &context::StatusTranscriptToolUsageBucket) -> Value {
    json!({
        "calls": bucket.calls,
        "results": bucket.results,
        "successes": bucket.successes,
        "failures": bucket.failures
    })
}

fn read_tasks(data_root: &Path) -> Value {
    let mut running = 0_u64;
    let mut recoverable = 0_u64;
    let mut failed = 0_u64;
    if let Ok(entries) = fs::read_dir(data_root.join("tasks")) {
        for entry in entries.flatten() {
            let status = fs::read_to_string(entry.path().join("status")).unwrap_or_default();
            match status.trim() {
                "RUNNING" => running += 1,
                "RECOVERABLE" => recoverable += 1,
                "FAILED" => failed += 1,
                _ => {}
            }
        }
    }
    json!({ "running": running, "recoverable": recoverable, "failed": failed })
}

fn read_json(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| json!({}))
}

fn safe_error(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.contains("://")
        || trimmed.to_ascii_lowercase().contains("token")
        || trimmed.len() > 240
    {
        "[redacted]".into()
    } else {
        trimmed.into()
    }
}

fn display(value: &Value) -> String {
    value
        .as_u64()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unavailable".into())
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests;
