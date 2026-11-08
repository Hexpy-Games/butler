//! The words of a step (`traceText.ts`) and the sizes and times it prints (`logFormat.ts`).
use butler_ds::ui::tag::Tone as TagTone;
use serde_json::Value;

use super::copy::Words;
use super::model::{Step, TraceSpan, TraceView, http_span, is_http};

/// `formatBytes`
pub(super) fn format_bytes(bytes: f64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes.max(0.);
    let mut unit = 0;
    while value >= 1024. && unit < UNITS.len() - 1 {
        value /= 1024.;
        unit += 1;
    }
    let digits = usize::from(!(unit == 0 || value >= 10.));
    format!("{value:.digits$} {}", UNITS[unit])
}

/// `formatDuration`
fn format_duration(ms: f64) -> String {
    if ms < 1. {
        format!("{ms:.2}ms")
    } else if ms < 1000. {
        format!("{}ms", ms.round())
    } else {
        format!("{:.2}s", ms / 1000.)
    }
}

/// `formatTraceMs`: "412ms" under a second, else "2.58s"; whole seconds drop the decimals.
pub(super) fn format_ms(copy: &Words, ms: f64) -> String {
    if ms <= 0. {
        return copy.seconds("0");
    }
    if ms < 1000. {
        return format!("{}ms", ms.round());
    }
    let seconds: f64 = format!("{:.2}", ms / 1000.).parse().unwrap_or_default();
    copy.seconds(&seconds.to_string())
}

/// `formatTraceStart`: "+0.58s", where the step starts on the trace.
pub(super) fn format_start(copy: &Words, offset: f64) -> String {
    format!("+{}", copy.seconds(&format!("{:.2}", offset / 1000.)))
}

/// A number attribute as JS prints it.
fn number(value: Option<&Value>) -> Option<&serde_json::Number> {
    match value {
        Some(Value::Number(number)) => Some(number),
        _ => None,
    }
}

/// `stepTitle`
pub(super) fn step_title(copy: &Words, step: &Step) -> String {
    let span = &step.span;
    // A request the agent received names its route ("App request · POST /messages").
    let received = http_span(step);
    if is_http(step)
        && let Some(route) = received.text("route").filter(|route| !route.is_empty())
    {
        let method = received.text("method");
        let named: Vec<&str> = method.into_iter().chain([route]).collect();
        let base = copy.step("http.server").unwrap_or_default();
        return format!("{base} · {}", named.join(" "));
    }
    let attrs = span.attrs.as_ref();
    let base = copy.step(&span.name).map_or_else(
        || {
            if span.title.is_empty() {
                span.name.clone()
            } else {
                span.title.clone()
            }
        },
        str::to_owned,
    );
    let attempt = number(attrs.and_then(|attrs| attrs.get("attempt")));
    let attempts = number(attrs.and_then(|attrs| attrs.get("attempts")));
    if span.name == "model.request"
        && let (Some(attempt), Some(attempts)) = (attempt, attempts)
        && attempts.as_f64().is_some_and(|count| count > 1.)
    {
        return format!("{base} {attempt}/{attempts}");
    }
    let subject = match span.name.as_str() {
        "tool.call" => span.text("name"),
        "mcp.call" => span.text("method"),
        _ => None,
    };
    match subject {
        Some(subject) if !subject.is_empty() => format!("{base} · {subject}"),
        _ => base,
    }
}

fn http_status(span: &TraceSpan) -> Option<i64> {
    span.attrs.as_ref()?.get("status")?.as_i64()
}

/// `stepTag`: status beside the title: the HTTP status (its own, else its latest HTTP child's),
/// wait, failure or running.
pub(super) fn step_tag(copy: &Words, steps: &[Step], index: usize) -> Option<(String, TagTone)> {
    let step = &steps[index];
    let latest_http = step
        .children
        .iter()
        .rev()
        .map(|child| &steps[*child])
        .filter(|child| is_http(child));
    let status = std::iter::once(step)
        .chain(latest_http)
        .find_map(|candidate| http_status(http_span(candidate)));
    if let Some(status) = status {
        let tone = if status >= 400 {
            TagTone::Danger
        } else {
            TagTone::Neutral
        };
        return Some((status.to_string(), tone));
    }
    match step.span.status.as_str() {
        "wait" => Some((copy.wait.to_owned(), TagTone::Warning)),
        "error" => Some((copy.failed.to_owned(), TagTone::Danger)),
        _ if step.running => Some((copy.running.to_owned(), TagTone::Neutral)),
        _ => None,
    }
}

/// Shown elsewhere (IDs, timing, the HTTP blocks) or internal; never a detail field.
const HIDDEN: [&str; 6] = [
    "trace_id",
    "span_id",
    "parent_span_id",
    "started_at",
    "start",
    "log_level",
];
const HTTP_KEYS: [&str; 8] = [
    "method",
    "path",
    "url",
    "route",
    "status",
    "request_headers",
    "response_headers",
    "headers",
];

/// Attributes a step's title already spells out.
fn titled(name: &str) -> &'static [&'static str] {
    match name {
        "model.request" => &["attempt", "attempts"],
        "tool.call" => &["name"],
        "mcp.call" => &["method"],
        _ => &[],
    }
}

pub(super) struct Field {
    pub(super) label: String,
    pub(super) value: String,
}

/// `stepFields`: a step's attributes, labelled, minus what the row or the summary already shows.
pub(super) fn step_fields(copy: &Words, step: &Step, trace: &TraceView) -> Vec<Field> {
    let http = is_http(step);
    let skip = titled(&step.span.name);
    let Some(attrs) = step.span.attrs.as_ref() else {
        return Vec::new();
    };
    attrs
        .iter()
        .filter(|(key, value)| {
            let key = key.as_str();
            let repeated = |own: &Option<String>| {
                own.as_deref()
                    .is_some_and(|own| value.as_str() == Some(own))
            };
            !(HIDDEN.contains(&key)
                || skip.contains(&key)
                || http && HTTP_KEYS.contains(&key)
                || value.is_null()
                || value.as_str() == Some("")
                || key == "chat_id" && repeated(&trace.chat_id)
                || key == "turn_id" && repeated(&trace.turn_id)
                // The status word repeats the row's dot and tag.
                || key == "status" && value.is_string())
        })
        .map(|(key, value)| Field {
            label: copy.attr(key).map_or_else(|| key.clone(), str::to_owned),
            value: field_text(key, value),
        })
        .collect()
}

fn field_text(key: &str, value: &Value) -> String {
    match value {
        Value::Number(n) if key.ends_with("_ms") => {
            n.as_f64().map_or_else(|| n.to_string(), format_duration)
        }
        Value::Number(n) if key.ends_with("_bytes") => {
            n.as_f64().map_or_else(|| n.to_string(), format_bytes)
        }
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}
