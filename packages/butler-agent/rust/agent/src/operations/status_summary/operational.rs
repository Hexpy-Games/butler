//! Operational event and first-visible summaries with source filtering/redaction.

use std::{collections::BTreeMap, path::Path};

use serde_json::{Map, Value, json};

use super::stream::{number, visit_jsonl};

const DURATION_SAMPLE_LIMIT: usize = 4_096;
const SUMMARY_KEY_LIMIT: usize = 512;
const CATEGORY_LIMIT: usize = 32;

#[derive(Default)]
struct DurationSummary {
    samples: Vec<f64>,
    seen: usize,
    sum: f64,
    min: Option<f64>,
    max: Option<f64>,
}

#[derive(Default)]
struct Bucket {
    events: u64,
    errors: u64,
    skipped: u64,
    durations: DurationSummary,
}

pub(super) fn metrics_enabled(data_root: &Path) -> bool {
    crate::operations::metrics_enabled(data_root)
}

pub(super) fn read_summary(data_root: &Path, since_ts: Option<f64>, enabled: bool) -> Value {
    let mut by_category = BTreeMap::<String, Bucket>::new();
    let mut by_name = BTreeMap::<String, Bucket>::new();
    let mut latest: Option<f64> = None;
    let mut total = 0_u64;
    let path = data_root.join("metrics/operational-events.jsonl");
    let parse_errors = visit_jsonl(&path, |_, parsed| {
        let Ok(value) = parsed else { return };
        let Some(event) = operational_event(&value) else {
            return;
        };
        if since_ts.is_some_and(|since| event["ts"].as_f64().unwrap_or(0.0) < since) {
            return;
        }
        total += 1;
        let category = event["category"].as_str().unwrap_or("maintenance");
        let category_key =
            if by_category.contains_key(category) || by_category.len() < CATEGORY_LIMIT {
                category.to_owned()
            } else {
                "maintenance".into()
            };
        let name = event["name"].as_str().unwrap_or("unknown");
        let candidate_name = format!("{category_key}:{name}");
        let name_key = if by_name.contains_key(&candidate_name) || by_name.len() < SUMMARY_KEY_LIMIT
        {
            candidate_name
        } else {
            "__other__".into()
        };
        let status = event["status"].as_str().unwrap_or("ok");
        add_event(
            by_category.entry(category_key).or_default(),
            status,
            number(event.get("durationMs")),
        );
        add_event(
            by_name.entry(name_key).or_default(),
            status,
            number(event.get("durationMs")),
        );
        latest = Some(
            latest.map_or(event["ts"].as_f64().unwrap_or(0.0), |current| {
                current.max(event["ts"].as_f64().unwrap_or(0.0))
            }),
        );
    });
    let by_category = by_category
        .into_iter()
        .map(|(key, bucket)| (key, bucket_json(bucket)))
        .collect::<Map<_, _>>();
    let by_name = by_name
        .into_iter()
        .map(|(key, bucket)| (key, bucket_json(bucket)))
        .collect::<Map<_, _>>();
    json!({
        "enabled": enabled,
        "totalEvents": total,
        "parseErrors": parse_errors,
        "sinceTs": since_ts,
        "byCategory": by_category,
        "byName": by_name,
        "latestEventTs": latest,
        "privacy": {
            "rawTextStored": false,
            "rawPromptsIncluded": false,
            "rawMessagesIncluded": false,
            "rawToolPayloadsIncluded": false,
            "rawCredentialsIncluded": false
        }
    })
}

pub(super) fn read_first_visible(data_root: &Path, since_ts: Option<f64>) -> Value {
    let mut events = 0_u64;
    let mut latest = Value::Null;
    let mut durations = Vec::new();
    let mut duration_total = 0.0;
    let mut duration_count = 0_u64;
    let mut by_signal = BTreeMap::<String, u64>::new();
    let path = data_root.join("metrics/operational-events.jsonl");
    let _ = visit_jsonl(&path, |_, parsed| {
        let Ok(value) = parsed else { return };
        let Some(event) = operational_event(&value) else {
            return;
        };
        if event["category"] != "runtime" || event["name"] != "first_visible_latency" {
            return;
        }
        if since_ts.is_some_and(|since| event["ts"].as_f64().unwrap_or(0.0) < since) {
            return;
        }
        events += 1;
        latest = event.clone();
        if let Some(duration) = number(event.get("durationMs")) {
            duration_total += duration;
            duration_count += 1;
            if durations.len() < DURATION_SAMPLE_LIMIT {
                durations.push(duration);
            } else {
                durations[(events as usize) % DURATION_SAMPLE_LIMIT] = duration;
            }
        }
        if let Some(signal) = event.pointer("/dimensions/signal").and_then(Value::as_str) {
            *by_signal.entry(signal.to_owned()).or_default() += 1;
        }
    });
    let mut sorted = durations;
    sorted.sort_by(f64::total_cmp);
    json!({
        "events": events,
        "latest": latest,
        "averageMs": (duration_count > 0).then(|| round_two(duration_total / duration_count as f64)),
        "p50Ms": percentile(&sorted, 50),
        "p95Ms": percentile(&sorted, 95),
        "bySignal": by_signal,
        "privacy": { "rawTextStored": false }
    })
}

pub(super) fn operational_event(value: &Value) -> Option<Value> {
    if value.get("schema")?.as_str()? != "butler.operational-metric.v1"
        || number(value.get("ts")).is_none()
        || value.get("category")?.as_str().is_none()
        || value.get("name")?.as_str().is_none()
        || !matches!(value.get("status")?.as_str()?, "ok" | "error" | "skipped")
    {
        return None;
    }
    let mut event = Map::new();
    for key in ["schema", "category", "name", "status"] {
        if let Some(value) = value.get(key) {
            event.insert(key.into(), value.clone());
        }
    }
    event.insert("ts".into(), value.get("ts")?.clone());
    if let Some(duration) = number(value.get("durationMs")) {
        event.insert("durationMs".into(), json!(duration));
    }
    if let Some(metric_value) = number(value.get("value")) {
        event.insert("value".into(), json!(metric_value));
    }
    if let Some(unit) = value.get("unit").and_then(Value::as_str) {
        event.insert("unit".into(), json!(unit));
    }
    if let Some(dimensions) = sanitize_dimensions(value.get("dimensions")) {
        event.insert("dimensions".into(), Value::Object(dimensions));
    }
    event.insert("rawTextStored".into(), Value::Bool(false));
    Some(Value::Object(event))
}

fn sanitize_dimensions(value: Option<&Value>) -> Option<Map<String, Value>> {
    let mut output = Map::new();
    for (key, value) in value?.as_object()? {
        let trimmed = key.trim();
        if trimmed.is_empty()
            || trimmed.len() > 80
            || !trimmed.chars().enumerate().all(|(index, ch)| {
                if index == 0 {
                    ch.is_ascii_alphabetic()
                } else {
                    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-')
                }
            })
        {
            continue;
        }
        if unsafe_dimension_key(trimmed, value) {
            continue;
        }
        let safe = match value {
            Value::Null | Value::Bool(_) => Some(value.clone()),
            Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => {
                Some(value.clone())
            }
            Value::String(text) => {
                let text = text.trim();
                if text.is_empty() {
                    Some(json!(""))
                } else if text.len() <= 160 && !text.contains("://") {
                    Some(json!(text))
                } else if text.len() > 160 && !text.contains("://") {
                    Some(json!(format!("{}…", truncate_utf8(text, 160))))
                } else {
                    None
                }
            }
            _ => None,
        };
        if let Some(value) = safe {
            output.insert(trimmed.to_owned(), value);
        }
    }
    (!output.is_empty()).then_some(output)
}

fn unsafe_dimension_key(key: &str, value: &Value) -> bool {
    let lower = key.to_ascii_lowercase();
    let count_suffix = [
        "tokens",
        "chars",
        "bytes",
        "count",
        "ratio",
        "ms",
        "duration",
        "latency",
        "attempts",
        "retries",
        "failures",
        "successes",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix));
    if count_suffix && value.is_number() {
        return false;
    }
    [
        "prompt",
        "message",
        "transcript",
        "query",
        "url",
        "uri",
        "arg",
        "args",
        "argument",
        "arguments",
        "result",
        "content",
        "raw",
        "secret",
        "password",
        "credential",
        "apikey",
        "api_key",
        "key",
        "token",
    ]
    .iter()
    .any(|term| lower == *term || lower.split(['_', '-']).any(|part| part == *term))
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    let mut end = max_bytes.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn add_event(bucket: &mut Bucket, status: &str, duration: Option<f64>) {
    bucket.events += 1;
    if status == "error" {
        bucket.errors += 1;
    }
    if status == "skipped" {
        bucket.skipped += 1;
    }
    if let Some(duration) = duration {
        let durations = &mut bucket.durations;
        durations.seen += 1;
        durations.sum += duration;
        durations.min = Some(
            durations
                .min
                .map_or(duration, |current| current.min(duration)),
        );
        durations.max = Some(
            durations
                .max
                .map_or(duration, |current| current.max(duration)),
        );
        if durations.samples.len() < DURATION_SAMPLE_LIMIT {
            durations.samples.push(duration);
        } else {
            durations.samples[durations.seen % DURATION_SAMPLE_LIMIT] = duration;
        }
    }
}

fn bucket_json(bucket: Bucket) -> Value {
    let durations = bucket.durations;
    let mut sorted = durations.samples;
    sorted.sort_by(f64::total_cmp);
    let duration = if durations.seen == 0 {
        json!({ "count": 0, "min": null, "max": null, "average": null, "p50": null, "p95": null })
    } else {
        json!({
            "count": durations.seen,
            "min": durations.min,
            "max": durations.max,
            "average": round_two(durations.sum / durations.seen as f64),
            "p50": percentile(&sorted, 50),
            "p95": percentile(&sorted, 95)
        })
    };
    json!({ "events": bucket.events, "errors": bucket.errors, "skipped": bucket.skipped, "durationMs": duration })
}

fn percentile(values: &[f64], percent: usize) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let index = ((percent * values.len()).div_ceil(100))
        .saturating_sub(1)
        .min(values.len() - 1);
    Some(values[index])
}

fn round_two(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}
