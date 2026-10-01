//! The public inventory contains only routes actually dispatched by this binary.

use serde_json::{Value, json};

#[derive(Clone, Copy)]
pub(super) struct Entry {
    id: &'static str,
    usage: &'static str,
    aliases: &'static [&'static str],
    summary: &'static str,
    priority: &'static str,
    supports_json: bool,
}

macro_rules! route {
    ($id:literal, $usage:literal, $summary:literal, $priority:literal) => {
        Entry {
            id: $id,
            usage: $usage,
            aliases: &[],
            summary: $summary,
            priority: $priority,
            supports_json: true,
        }
    };
    ($id:literal, $usage:literal, $summary:literal, $priority:literal, $json:expr) => {
        Entry {
            id: $id,
            usage: $usage,
            aliases: &[],
            summary: $summary,
            priority: $priority,
            supports_json: $json,
        }
    };
    ($id:literal, $usage:literal, $summary:literal, $priority:literal, $json:expr, $aliases:expr) => {
        Entry {
            id: $id,
            usage: $usage,
            aliases: $aliases,
            summary: $summary,
            priority: $priority,
            supports_json: $json,
        }
    };
}

mod core;

pub(super) fn all() -> Vec<Entry> {
    core::ROUTES.to_vec()
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
                "aliases": entry.aliases,
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
    let mut lines = vec!["Butler native commands".to_owned(), String::new()];
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
            lines.push(format!("  {}\n    {}", entry.usage, entry.summary));
        }
        lines.push(String::new());
    }
    lines.push("설치 / Install: npx @hexpygames/butler install".into());
    lines.join("\n")
}
