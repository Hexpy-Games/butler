//! Read-only web-search and transcript availability projections.

use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

use serde_json::{Value, json};

use super::super::stream::{number, unsigned_count, visit_jsonl};

pub(super) fn read_web_search(data_root: &Path, since_ts: Option<f64>) -> Value {
    if since_ts.is_none() {
        let metrics = read_json(&data_root.join("runtime/web-search-metrics.json"));
        return json!({
            "requestCount": unsigned_count(metrics.get("requestCount")).unwrap_or(0),
            "lastProvider": metrics.get("lastProvider").and_then(Value::as_str),
            "lastError": metrics.get("lastError").and_then(Value::as_str)
        });
    }
    let mut count = 0_u64;
    let mut latest = None::<(f64, String, Option<String>)>;
    let path = data_root.join("metrics/web-search-usage.jsonl");
    let _ = visit_jsonl(&path, |_, parsed| {
        let Ok(event) = parsed else { return };
        let Some(ts) = number(event.get("ts")) else {
            return;
        };
        let Some(provider) = event
            .get("provider")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        else {
            return;
        };
        if since_ts.is_some_and(|since| ts < since) {
            return;
        }
        count += 1;
        if latest.as_ref().is_none_or(|(current, _, _)| ts >= *current) {
            latest = Some((
                ts,
                provider.to_owned(),
                event
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            ));
        }
    });
    json!({
        "requestCount": count,
        "lastProvider": latest.as_ref().map(|(_, provider, _)| provider),
        "lastError": latest.as_ref().and_then(|(_, _, error)| error.as_ref())
    })
}

pub(super) fn read_tools(
    data_root: &Path,
    session_id: Option<&str>,
    since_ts: Option<f64>,
    transcript_activity: &super::super::health::TranscriptActivityProjection,
) -> (Value, Value, Value) {
    if let Some(session_id) = session_id.filter(|id| !id.trim().is_empty()) {
        let tools = read_session_tools(data_root, session_id, since_ts);
        return (
            tools,
            json!({"status":"available","reason":null}),
            json!({"status":"available","reason":null}),
        );
    }
    if since_ts.is_some() {
        return (
            json!({ "calls": 0, "results": 0, "successes": 0, "failures": 0, "byTool": {} }),
            transcript_activity.status.clone(),
            json!({ "status": "unavailable", "reason": "unscoped_since_filter_requires_session" }),
        );
    }
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

fn read_session_tools(data_root: &Path, session_id: &str, since_ts: Option<f64>) -> Value {
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
    let path = data_root.join("transcripts").join(format!("{safe}.jsonl"));
    let Ok(file) = File::open(path) else {
        return empty_tools();
    };
    let mut totals = [0_u64; 4];
    let mut by_tool = BTreeMap::<String, [u64; 4]>::new();
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    while reader
        .read_until(b'\n', &mut line)
        .ok()
        .is_some_and(|length| length > 0)
    {
        if let Ok(event) = serde_json::from_slice::<Value>(&line) {
            let in_window = since_ts.is_none_or(|since| {
                event
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(crate::js_date::parse_iso_millis)
                    .is_some_and(|ts| ts as f64 >= since)
            });
            if in_window {
                let kind = event.get("kind").and_then(Value::as_str);
                let name = event
                    .pointer("/payload/name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty());
                if let (Some(kind @ ("tool_call" | "tool_result")), Some(name)) = (kind, name) {
                    let key = if by_tool.contains_key(name) || by_tool.len() < 512 {
                        name
                    } else {
                        "__other__"
                    };
                    let bucket = by_tool.entry(key.to_owned()).or_default();
                    let index = if kind == "tool_call" {
                        0
                    } else if event.pointer("/payload/ok") == Some(&Value::Bool(false)) {
                        3
                    } else {
                        2
                    };
                    totals[index] += 1;
                    bucket[index] += 1;
                    if kind == "tool_result" {
                        totals[1] += 1;
                        bucket[1] += 1;
                    }
                }
            }
        }
        line.clear();
    }
    json!({"calls":totals[0],"results":totals[1],"successes":totals[2],
        "failures":totals[3],"byTool":by_tool.into_iter().map(|(name, count)| {
            (name,json!({"calls":count[0],"results":count[1],
                "successes":count[2],"failures":count[3]}))
        }).collect::<serde_json::Map<String,Value>>()})
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
