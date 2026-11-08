//! `SystemEventCard.tsx`: one event of the list.
use butler_ds::ui::context::Lang;
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use chrono::{DateTime, Local, Timelike as _};
use gpui::{IntoElement, ParentElement as _};
use serde::Deserialize;
use serde_json::Value;

use super::copy::Words;

#[derive(Deserialize)]
pub(super) struct Metric {
    label: String,
    value: Value,
}

#[derive(Deserialize)]
pub(super) struct Event {
    kind: String,
    title: String,
    status: String,
    occurred_at: Option<String>,
    duration_ms: Option<f64>,
    model_ref: Option<String>,
    uses_butler_model: Option<bool>,
    metrics: Vec<Metric>,
}

/// `systemEventTitle`
fn title(event: &Event, copy: &Words) -> String {
    let [profile, consolidation, session_sync, maintenance, cycle] = copy.titles;
    match event.kind.as_str() {
        "profile_consolidation" => return profile.into(),
        "consolidation_run" => return consolidation.into(),
        _ => {}
    }
    let job = event
        .metrics
        .iter()
        .find(|metric| metric.label == "job_id")
        .and_then(|metric| metric.value.as_str());
    match job {
        Some("session-sync") => session_sync.into(),
        Some("context-maintenance") => maintenance.into(),
        Some("consolidation-cycle") => cycle.into(),
        _ => event.title.clone(),
    }
}

/// `systemEventStatus`
fn status(status: &str, copy: &Words) -> &'static str {
    let [ok, completed, failed, running, not_run, unknown] = copy.statuses;
    match status {
        "ok" => ok,
        "completed" => completed,
        "failed" => failed,
        "running" => running,
        "not_run" => not_run,
        _ => unknown,
    }
}

/// `systemEventMetricValue`
fn metric_value(value: &Value, copy: &Words) -> String {
    let [yes, no, deep, basic, off] = copy.values;
    match value {
        Value::Bool(true) => yes.into(),
        Value::Bool(false) => no.into(),
        Value::String(text) => match text.as_str() {
            "deep" => deep.into(),
            "basic" => basic.into(),
            "off" => off.into(),
            other => other.into(),
        },
        other => other.to_string(),
    }
}

/// `formatMetrics`: the first eight metrics, minus the ones that are not for display.
fn metrics(event: &Event, copy: &Words) -> String {
    event
        .metrics
        .iter()
        .filter(|metric| metric.label != "raw_text_included" && metric.label != "job_id")
        .take(8)
        .map(|metric| {
            let label = copy
                .metrics
                .iter()
                .find(|(key, _)| *key == metric.label)
                .map_or(metric.label.as_str(), |(_, label)| label);
            format!("{label}: {}", metric_value(&metric.value, copy))
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

/// `formatDuration`
fn duration(ms: f64) -> String {
    if ms < 1000.0 {
        format!("{ms}ms")
    } else {
        format!("{}s", (ms / 100.0).round() / 10.0)
    }
}

/// `formatTimestamp`: the local date and time; the raw text when it does not parse. Both
/// locales' `Intl.DateTimeFormat` default to a 12-hour clock with two-digit fields.
fn timestamp(value: &str, lang: Lang) -> String {
    let Ok(at) = DateTime::parse_from_rfc3339(value) else {
        return value.to_owned();
    };
    let at = at.with_timezone(&Local);
    let afternoon = at.hour() >= 12;
    match lang {
        Lang::Ko => {
            let half = if afternoon { "오후" } else { "오전" };
            format!(
                "{} {half} {}",
                at.format("%Y. %m. %d."),
                at.format("%I:%M:%S")
            )
        }
        Lang::En => {
            let half = if afternoon { "PM" } else { "AM" };
            format!("{} {half}", at.format("%m/%d/%Y, %I:%M:%S"))
        }
    }
}

pub(super) fn card(event: &Event, lang: Lang, copy: &Words) -> impl IntoElement {
    let mut parts = vec![status(&event.status, copy).to_owned()];
    parts.extend(
        event
            .occurred_at
            .as_deref()
            .filter(|at| !at.is_empty())
            .map(|at| timestamp(at, lang)),
    );
    if let Some(model) = &event.model_ref {
        parts.push(model.clone());
        if event.uses_butler_model == Some(true) {
            parts.push(copy.model_default.to_owned());
        }
    }
    let caption = parts.join(" · ");
    let metrics = metrics(event, copy);
    Stack::new()
        .gap(Space::Sm)
        .child(
            Stack::row()
                .cross(Cross::Center)
                .justify(Justify::Between)
                .gap(Space::Md)
                .wrap(true)
                .child(
                    Stack::new()
                        .gap(Space::Xs)
                        .child(Typo::body(title(event, copy)))
                        .child(Typo::caption(caption).tone(Tone::Secondary)),
                )
                .children(
                    event
                        .duration_ms
                        .map(|ms| Typo::caption(duration(ms)).tone(Tone::Secondary)),
                ),
        )
        .children((!metrics.is_empty()).then(|| Typo::caption(metrics).tone(Tone::Secondary)))
}
