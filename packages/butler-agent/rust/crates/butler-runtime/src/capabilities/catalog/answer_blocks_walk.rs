//! Shared traversal for specs, sets, closed draft units and image evidence.
use serde_json::Value;

pub fn walk(value: &Value, visit: &mut impl FnMut(&Value)) {
    visit(value);
    match value {
        Value::Object(fields) => {
            for child in fields.values() {
                walk(child, visit);
            }
        }
        Value::Array(items) => {
            for child in items {
                walk(child, visit);
            }
        }
        _ => {}
    }
}

pub fn image_ids(value: &Value) -> Vec<String> {
    let mut ids = std::collections::BTreeSet::new();
    walk(value, &mut |item| {
        if let Some(id) = item.get("img").and_then(Value::as_str) {
            ids.insert(id.to_owned());
        }
    });
    ids.into_iter().collect()
}

pub(super) fn defaults(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            match fields.get("type").and_then(Value::as_str) {
                Some("cards" | "gallery") => {
                    fields.entry("media").or_insert(serde_json::json!("1:1"));
                }
                Some("callout") => {
                    fields.entry("tone").or_insert(serde_json::json!("neutral"));
                }
                _ => {}
            }
            for child in fields.values_mut() {
                defaults(child);
            }
        }
        Value::Array(items) => {
            for child in items {
                defaults(child);
            }
        }
        _ => {}
    }
}

pub(super) fn structure(spec: &Value, problems: &mut Vec<super::AnswerBlocksProblem>) {
    let mut ids = std::collections::HashSet::new();
    let mut leaves = 0;
    structure_at(spec, "", &mut ids, &mut leaves, problems);
    if leaves > 16 {
        super::push(
            problems,
            "/blocks",
            "use at most 16 blocks in all; move detail to reply text or another call",
        );
    }
}

fn structure_at<'a>(
    value: &'a Value,
    path: &str,
    ids: &mut std::collections::HashSet<&'a str>,
    leaves: &mut usize,
    problems: &mut Vec<super::AnswerBlocksProblem>,
) {
    if value.get("type").and_then(Value::as_str).is_some() {
        if let Some(id) = value.get("id").and_then(Value::as_str)
            && !ids.insert(id)
        {
            super::push(
                problems,
                &super::pointer(path, "id"),
                "duplicate id; give each block a distinct id across the whole spec",
            );
        }
        if !matches!(value["type"].as_str(), Some("columns" | "tabs" | "group")) {
            *leaves += 1;
        }
    }
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                structure_at(child, &super::pointer(path, key), ids, leaves, problems);
            }
        }
        Value::Array(items) => {
            for (i, child) in items.iter().enumerate() {
                structure_at(
                    child,
                    &super::pointer(path, &i.to_string()),
                    ids,
                    leaves,
                    problems,
                );
            }
        }
        _ => {}
    }
}
