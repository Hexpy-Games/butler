//! Mutable JSON statistics view helpers shared by App and Ledger projections.

use chrono::DateTime;
use serde_json::{Map, Value, json};

use super::calendar::{Calendar, Day, iso};

const OUTCOMES: &[&str] = &["delivered", "failed", "cancelled"];

pub(super) fn base(calendar: &Calendar) -> Value {
    let labels = calendar
        .days
        .iter()
        .map(|day| day.date.clone())
        .collect::<Vec<_>>();
    json!({
        "timezone":calendar.timezone,
        "period":calendar.days.len(),
        "observedAt":calendar.observed_at,
        "days":calendar.days.iter().map(day_json).collect::<Vec<_>>(),
        "sources":{},
        "work":Value::Null,
        "ledgerHistoryAvailable":false,
        "sessionHistoryAvailable":false,
        "activity":series(&labels, &["conversations","work","materials"]),
        "materials":series(&labels, &["created","updated","artifacts"]),
        "materialTypes":series(&labels, &["spec","plan","report","artifacts"]),
        "execution":{
            "outcomes":series(&labels,OUTCOMES),
            "duration":series(&["under30s","under2m","under10m","over10m"],OUTCOMES),
            "excluded":0,
        },
        "usage":{"status":"unavailable","reason":"project_usage_not_collected"},
    })
}

pub(super) fn series(labels: &[impl AsRef<str>], keys: &[&str]) -> Value {
    json!({
        "keys":keys,
        "buckets":labels.iter().map(|label| {
            let values = keys
                .iter()
                .map(|key| ((*key).to_owned(), Value::Array(Vec::new())))
                .collect::<Map<_, _>>();
            json!({"label":label.as_ref(),"values":values})
        }).collect::<Vec<_>>(),
    })
}

pub(super) fn add(view: &mut Value, path: &[&str], day: usize, metric: &str, key: &str) {
    let Some(values) = path_value_mut(view, path)
        .and_then(|series| series["buckets"].as_array_mut())
        .and_then(|buckets| buckets.get_mut(day))
        .and_then(|bucket| bucket["values"].get_mut(metric))
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    if !values.iter().any(|value| value.as_str() == Some(key)) {
        values.push(Value::String(key.to_owned()));
    }
}

pub(super) fn set_source(view: &mut Value, key: &str, source: Value) {
    if let Some(sources) = view["sources"].as_object_mut() {
        sources.insert(key.to_owned(), source);
    }
}

pub(super) fn source_count(view: &Value) -> usize {
    view["sources"].as_object().map_or(0, Map::len)
}

pub(super) fn day_index(days: &[Day], at: &str) -> Option<usize> {
    let time = DateTime::parse_from_rfc3339(at).ok()?.timestamp_millis();
    days.iter()
        .position(|day| time >= day.start_ms && time < day.end_ms)
}

fn day_json(day: &Day) -> Value {
    json!({
        "date":day.date,
        "start":iso(day.start_ms),
        "end":iso(day.end_ms),
        "partial":day.partial,
    })
}

fn path_value_mut<'a>(value: &'a mut Value, path: &[&str]) -> Option<&'a mut Value> {
    path.iter()
        .try_fold(value, |value, key| value.get_mut(*key))
}
