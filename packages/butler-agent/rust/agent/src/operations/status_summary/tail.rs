use std::{collections::VecDeque, path::Path};

use serde_json::Value;

use super::{
    operational::operational_event,
    stream::{number, visit_jsonl},
};

pub(super) fn tail_events(data_root: &Path, since_ts: Option<f64>, lines: usize) -> Vec<Value> {
    if lines == 0 {
        return Vec::new();
    }
    let mut events = VecDeque::with_capacity(lines.min(500));
    let path = data_root.join("metrics/operational-events.jsonl");
    let _ = visit_jsonl(&path, |_, parsed| {
        let Ok(value) = parsed else { return };
        let Some(event) = operational_event(&value) else {
            return;
        };
        let timestamp = number(event.get("ts")).unwrap_or(0.0);
        if since_ts.is_some_and(|since| timestamp < since) {
            return;
        }
        if events.len() == lines {
            events.pop_front();
        }
        events.push_back(event);
    });
    events.into_iter().collect()
}
