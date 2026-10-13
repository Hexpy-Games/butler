//! Normalization and replacement semantics shared by acceptance and durable closeout.
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

pub fn normalize(spec: &mut Value) {
    trim(spec);
    if let Some(blocks) = spec.get_mut("blocks").and_then(Value::as_array_mut) {
        for block in blocks {
            let Some(fields) = block.as_object_mut() else {
                continue;
            };
            match fields.get("type").and_then(Value::as_str) {
                Some("cards" | "gallery") => {
                    fields.entry("media").or_insert(json!("1:1"));
                }
                Some("callout") => {
                    fields.entry("tone").or_insert(json!("neutral"));
                }
                _ => {}
            }
        }
    }
}

fn trim(value: &mut Value) {
    match value {
        Value::String(text) => {
            *text = butler_core::public_text::trim_js_whitespace(text).to_owned();
        }
        Value::Array(items) => {
            for item in items {
                trim(item);
            }
        }
        Value::Object(fields) => {
            for field in fields.values_mut() {
                trim(field);
            }
        }
        _ => {}
    }
}

pub fn sources(spec: &Value) -> Vec<String> {
    fn visit(value: &Value, found: &mut BTreeSet<String>) {
        match value {
            Value::Object(fields) => {
                if let Some(source) = fields.get("source").and_then(Value::as_str)
                    && let Some(id) = super::source_identity(source)
                {
                    found.insert(id);
                }
                for field in fields.values() {
                    visit(field, found);
                }
            }
            Value::Array(items) => {
                for item in items {
                    visit(item, found);
                }
            }
            _ => {}
        }
    }
    let mut found = BTreeSet::new();
    visit(spec, &mut found);
    found.into_iter().collect()
}

/// Source identities of the items an answer pictures (an item with both `img` and `source`).
pub fn pictured_sources(sets: &[Value]) -> BTreeSet<String> {
    fn visit(value: &Value, found: &mut BTreeSet<String>) {
        match value {
            Value::Object(fields) => {
                if fields.get("img").and_then(Value::as_str).is_some()
                    && let Some(id) = fields
                        .get("source")
                        .and_then(Value::as_str)
                        .and_then(super::page_identity)
                {
                    found.insert(id);
                }
                for field in fields.values() {
                    visit(field, found);
                }
            }
            Value::Array(items) => {
                for item in items {
                    visit(item, found);
                }
            }
            _ => {}
        }
    }
    let mut found = BTreeSet::new();
    for set in sets {
        visit(&set["spec"], &mut found);
    }
    found
}

pub fn shown(spec: &Value) -> Map<String, Value> {
    let mut counts = Map::new();
    for block in spec["blocks"].as_array().into_iter().flatten() {
        let Some(kind) = block["type"].as_str() else {
            continue;
        };
        let count = if matches!(kind, "cards" | "gallery") {
            block["items"].as_array().map_or(0, Vec::len) as u64
        } else {
            1
        };
        let previous = counts.get(kind).and_then(Value::as_u64).unwrap_or(0);
        counts.insert(kind.into(), json!(previous + count));
    }
    counts
}

pub fn accept(sets: &mut Vec<Value>, call_id: &str, spec: Value) {
    let ids: BTreeSet<String> = spec["blocks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| b["id"].as_str().map(str::to_owned))
        .collect();
    sets.retain_mut(|set| {
        if set["call_id"] == call_id {
            return false;
        }
        if let Some(blocks) = set
            .pointer_mut("/spec/blocks")
            .and_then(Value::as_array_mut)
        {
            blocks.retain(|b| b["id"].as_str().is_none_or(|id| !ids.contains(id)));
            let remaining: Vec<_> = blocks
                .iter()
                .filter_map(|b| b["id"].as_str())
                .map(str::to_owned)
                .collect();
            if blocks.is_empty() {
                return false;
            }
            set["set_ids"] = json!(remaining);
        }
        true
    });
    sets.push(Value::Object(Map::from_iter([
        ("call_id".into(), json!(call_id)),
        ("set_ids".into(), json!(ids)),
        ("spec".into(), spec),
    ])));
}
