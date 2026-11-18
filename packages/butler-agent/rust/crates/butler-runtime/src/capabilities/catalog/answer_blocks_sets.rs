//! Normalization and replacement semantics shared by acceptance and durable
//! closeout; source URLs end where an autolink ends.
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

pub fn normalize(spec: &mut Value) {
    trim(spec);
    super::walk::defaults(spec);
}

pub(super) fn trim(value: &mut Value) {
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
            if let Some(Value::String(source)) = fields.get_mut("source") {
                let end = autolink_end(source).len();
                source.truncate(end);
            }
        }
        _ => {}
    }
}

/// A source URL ends where an autolink would (GFM): trailing punctuation and a
/// closing parenthesis without a matching opening one belong to the prose
/// around a copied link, not to the URL.
fn autolink_end(url: &str) -> &str {
    let mut end = url;
    while let Some(last) = end.chars().last() {
        let unmatched = last == ')' && end.matches(')').count() > end.matches('(').count();
        if !unmatched && !"?!.,:*_~".contains(last) {
            break;
        }
        end = &end[..end.len() - last.len_utf8()];
    }
    end
}

pub fn sources(spec: &Value) -> Vec<String> {
    let mut found = BTreeSet::new();
    super::walk(spec, &mut |value| {
        if let Some(id) = value
            .get("source")
            .and_then(Value::as_str)
            .and_then(super::source_identity)
        {
            found.insert(id);
        }
    });
    found.into_iter().collect()
}

/// Sources pictured by either image leaves or items, including container children.
pub fn pictured_sources(sets: &[Value]) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for set in sets {
        super::walk(&set["spec"], &mut |value| {
            if value.get("img").and_then(Value::as_str).is_some()
                && let Some(id) = value
                    .get("source")
                    .and_then(Value::as_str)
                    .and_then(super::page_identity)
            {
                found.insert(id);
            }
        });
    }
    found
}

pub fn shown(spec: &Value) -> Map<String, Value> {
    let mut counts = Map::new();
    super::walk(spec, &mut |block| {
        let Some(kind) = block["type"].as_str() else {
            return;
        };
        if matches!(kind, "columns" | "tabs" | "group") {
            return;
        }
        let count = if kind == "epics" {
            block["ids"].as_array().map_or(0, Vec::len) as u64
        } else if matches!(kind, "cards" | "gallery") {
            block["items"].as_array().map_or(0, Vec::len) as u64
        } else {
            1
        };
        let previous = counts.get(kind).and_then(Value::as_u64).unwrap_or(0);
        counts.insert(kind.into(), json!(previous + count));
    });
    counts
}

/// Child ids are globally unique, but replacement happens per top-level block.
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
