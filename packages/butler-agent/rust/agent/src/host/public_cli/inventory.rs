//! The public inventory contains only routes actually dispatched by this binary.

use serde_json::{Value, json};

#[derive(Clone, Copy)]
pub(super) struct Entry {
    id: &'static str,
    usage: &'static str,
    summary: &'static str,
    priority: &'static str,
    supports_json: bool,
}

macro_rules! route {
    ($id:literal, $usage:literal, $summary:literal, $priority:literal) => {
        Entry {
            id: $id,
            usage: $usage,
            summary: $summary,
            priority: $priority,
            supports_json: true,
        }
    };
    ($id:literal, $usage:literal, $summary:literal, $priority:literal, $json:expr) => {
        Entry {
            id: $id,
            usage: $usage,
            summary: $summary,
            priority: $priority,
            supports_json: $json,
        }
    };
}

mod advanced;
mod core;
mod operator_a;
mod operator_b;

pub(super) fn all() -> Vec<Entry> {
    [
        core::ROUTES,
        operator_a::ROUTES,
        operator_b::ROUTES,
        advanced::ROUTES,
    ]
    .concat()
}

pub(super) fn selected(path: &[String]) -> Vec<Entry> {
    all()
        .into_iter()
        .filter(|entry| {
            let parts = entry.id.split('.').collect::<Vec<_>>();
            path.len() <= parts.len()
                && path
                    .iter()
                    .zip(parts)
                    .all(|(wanted, actual)| wanted == actual)
        })
        .collect()
}

pub(super) fn values(entries: &[Entry]) -> Vec<Value> {
    entries
        .iter()
        .map(|entry| {
            json!({
                "id": entry.id,
                "usage": entry.usage,
                "path": entry.id.split('.').collect::<Vec<_>>(),
                "aliases": [],
                "priority": entry.priority,
                "status": "implemented",
                "summary": entry.summary,
                "implemented": true,
                "supportsJson": entry.supports_json,
                "spec": null,
            })
        })
        .collect()
}

pub(super) fn render(entries: &[Entry]) -> String {
    let mut lines = vec!["Butler native commands".to_owned(), "".to_owned()];
    for priority in ["core", "operator", "advanced"] {
        let selected = entries
            .iter()
            .filter(|entry| entry.priority == priority)
            .collect::<Vec<_>>();
        if selected.is_empty() {
            continue;
        }
        lines.push(format!("{priority}:"));
        for entry in selected {
            lines.push(format!("  {}", entry.usage));
        }
        lines.push(String::new());
    }
    lines.push("Mutable state uses BUTLER_DATA (default ~/.butler); --home and Bun runtime fallback are unsupported.".into());
    lines.join("\n")
}
