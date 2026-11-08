//! How a record reads (`logFormat.ts`, `logRecords.ts` `recordKey` and `matchesFilter`).
use butler_ds::ui::tag::Tone;
use chrono::{DateTime, Local};
use serde_json::{Map, Value};

use super::api::{Filter, LogRecord, SEVERITIES};
use super::copy::LogsCopy;

const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
const TARGET_LIMIT: usize = 64;
const SUMMARY_KEYS: [&str; 6] = ["ts", "level", "category", "process", "msg", "duration_ms"];

pub(super) fn format_bytes(bytes: u64) -> String {
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024. && unit < UNITS.len() - 1 {
        value /= 1024.;
        unit += 1;
    }
    let digits = usize::from(!(unit == 0 || value >= 10.));
    format!("{value:.digits$} {}", UNITS[unit])
}

pub(super) fn format_duration(ms: f64) -> String {
    if ms < 1. {
        format!("{ms:.2}ms")
    } else if ms < 1000. {
        format!("{ms:.0}ms")
    } else {
        format!("{:.2}s", ms / 1000.)
    }
}

/// Clock time for today's records; month, day and minute for older ones.
pub(super) fn format_log_time(ts: &str) -> String {
    let Ok(date) = DateTime::parse_from_rfc3339(ts) else {
        return ts.to_owned();
    };
    let date = date.with_timezone(&Local);
    if date.date_naive() == Local::now().date_naive() {
        date.format("%H:%M:%S").to_string()
    } else {
        date.format("%m/%d %H:%M").to_string()
    }
}

/// The index of the level in [`SEVERITIES`].
pub(super) fn severity_of(level: &str) -> Option<usize> {
    let level = level.to_lowercase();
    SEVERITIES.iter().position(|severity| *severity == level)
}

pub(super) fn severity_label(level: &str, copy: &LogsCopy) -> String {
    severity_of(level).map_or_else(|| level.to_owned(), |index| copy.severity[index].into())
}

pub(super) fn severity_tone(level: &str) -> Tone {
    match severity_of(level) {
        Some(0) => Tone::Danger,
        Some(1) => Tone::Warning,
        _ => Tone::Neutral,
    }
}

/// A record's identity: the same record from a page and from the live stream share it.
pub(super) fn record_key(row: &LogRecord) -> String {
    [
        row.ts.as_str(),
        &row.process,
        &row.category,
        &row.event,
        row.span_id.as_deref().unwrap_or(""),
        &row.msg,
    ]
    .join("|")
}

/// Client-side filter for live rows, matching the agent's query semantics.
pub(super) fn matches_filter(row: &LogRecord, filter: &Filter) -> bool {
    if !filter.level.is_empty() && row.level.to_lowercase() != filter.level.to_lowercase() {
        return false;
    }
    if filter.source != "all" && row.process != filter.source {
        return false;
    }
    if !filter.category.is_empty()
        && row.category != filter.category
        && !row.category.starts_with(&format!("{}.", filter.category))
    {
        return false;
    }
    let q = filter.q.trim();
    q.is_empty() || serde_json::to_string(row).is_ok_and(|json| json.contains(q))
}

/// Request/response attributes, when the record describes an HTTP exchange.
pub(super) fn http_attrs(record: &LogRecord) -> Option<&Map<String, Value>> {
    let attrs = record.attrs.as_ref()?;
    ["method", "url", "route", "path", "status"]
        .iter()
        .any(|key| attrs.contains_key(*key))
        .then_some(attrs)
}

/// `a ?? b`: the first of the keys that is present and not null.
pub(super) fn first_of<'a>(attrs: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .filter_map(|key| attrs.get(*key))
        .find(|value| !value.is_null())
}

/// `String(value)`
pub(super) fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Where a request went: the route template or path, or a URL's host and path (no scheme or
/// query).
fn http_target(attrs: &Map<String, Value>) -> Option<String> {
    if let Some(Value::String(route)) = first_of(attrs, &["route", "path"])
        && !route.is_empty()
    {
        return Some(route.clone());
    }
    let Some(Value::String(url)) = attrs.get("url").filter(|url| !url.is_null()) else {
        return None;
    };
    if url.is_empty() {
        return None;
    }
    if let Ok(parsed) = url::Url::parse(url) {
        let host = parsed.host_str().unwrap_or_default();
        let port = parsed
            .port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default();
        let path = if parsed.path() == "/" {
            ""
        } else {
            parsed.path()
        };
        return Some(format!("{host}{port}{path}"));
    }
    let bare = url.split(['?', '#']).next().unwrap_or_default();
    (!bare.is_empty()).then(|| bare.to_owned())
}

/// A row title from the record's HTTP attributes: "POST /sessions/{id}/messages · 500". Long
/// targets end in an ellipsis; the full value stays in the opened row.
pub(super) fn log_title(record: &LogRecord) -> String {
    let fallback = if record.msg.is_empty() {
        record.event.clone()
    } else {
        record.msg.clone()
    };
    if record.process.starts_with("app.") {
        return fallback;
    }
    let Some(attrs) = http_attrs(record) else {
        return fallback;
    };
    let method = attrs
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_uppercase);
    let target = http_target(attrs);
    if method.is_none() && target.is_none() {
        return fallback;
    }
    let shown = target.map(|target| {
        if target.chars().count() > TARGET_LIMIT {
            let head: String = target.chars().take(TARGET_LIMIT - 1).collect();
            format!("{head}…")
        } else {
            target
        }
    });
    let request = [method, shown]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    match attrs.get("status") {
        None | Some(Value::Null) => request,
        Some(status) => format!("{request} · {}", js_string(status)),
    }
}

/// True when the record holds anything the collapsed row does not already show.
pub(super) fn has_detail(record: &LogRecord) -> bool {
    let Ok(Value::Object(fields)) = serde_json::to_value(record) else {
        return false;
    };
    fields.iter().any(|(key, value)| {
        if SUMMARY_KEYS.contains(&key.as_str()) || value.is_null() {
            return false;
        }
        // App titles use prose; keep the stable event id available in details.
        if key == "attrs" {
            return value.as_object().is_some_and(|attrs| !attrs.is_empty());
        }
        key != "event" || (record.process.starts_with("app.") && record.event != record.msg)
    })
}

pub(super) fn pretty_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into())
}

/// Header maps as returned (already redacted), one `name: value` per line.
pub(super) fn format_headers(value: Option<&Value>) -> String {
    let Some(Value::Object(headers)) = value else {
        return String::new();
    };
    headers
        .iter()
        .map(|(name, header)| match header {
            Value::String(text) => format!("{name}: {text}"),
            other => format!("{name}: {other}"),
        })
        .collect::<Vec<_>>()
        .join("\n")
}
