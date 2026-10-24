//! Structured answers: atomic validation against the bundled contract and turn evidence.

use std::{collections::HashSet, sync::LazyLock};

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::Value;
use url::Url;

#[path = "answer_blocks_draft.rs"]
mod draft;
#[path = "answer_blocks_scanner.rs"]
mod scanner;
#[path = "answer_blocks_schema.rs"]
mod schema;
#[path = "answer_blocks_sets.rs"]
mod sets;
#[path = "answer_blocks_walk.rs"]
mod walk;
pub use draft::{AnswerBlocksDraftOp, AnswerBlocksDraftUnit, AnswerBlocksParser};
pub use sets::{accept, normalize, pictured_sources, shown, sources};
pub use walk::{image_ids, walk};

pub const ANSWER_BLOCKS_SCHEMA: &str = include_str!("answer-blocks.schema.json");
pub const MAX_SPEC_BYTES: usize = 32 * 1024;
const MAX_PROBLEMS: usize = 10;
static CONTRACT: LazyLock<Result<Value, serde_json::Error>> =
    LazyLock::new(|| serde_json::from_str(ANSWER_BLOCKS_SCHEMA));

/// Evidence is supplied by the asset store and the current conversation, not the model.
pub struct AnswerBlocksContext<'a> {
    pub now: DateTime<Utc>,
    pub image_exists: &'a dyn Fn(&str) -> bool,
    pub read_sources: &'a [String],
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AnswerBlocksProblem {
    pub path: String,
    pub fix: String,
}

/// Rejects the entire call; reports up to ten actionable JSON-pointer problems.
pub fn validate_answer_blocks(
    spec: &Value,
    context: &AnswerBlocksContext<'_>,
) -> Result<(), Vec<AnswerBlocksProblem>> {
    let mut problems = Vec::new();
    if serde_json::to_vec(spec).map_or(true, |bytes| bytes.len() > MAX_SPEC_BYTES) {
        push(
            &mut problems,
            "",
            "spec exceeds 32 KB; move detail to reply text or send separate calls",
        );
        return Err(problems);
    }
    let Ok(contract) = CONTRACT.as_ref() else {
        push(
            &mut problems,
            "",
            "answer schema is unavailable; use reply text for this turn",
        );
        return Err(problems);
    };
    schema::validate(spec, contract, contract, "", &mut problems);
    walk::structure(spec, &mut problems);
    let read = context
        .read_sources
        .iter()
        .filter_map(|s| source_identity(s))
        .collect();
    semantic(spec, "", context, &read, &mut problems);
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

pub(super) fn push(problems: &mut Vec<AnswerBlocksProblem>, path: &str, fix: impl Into<String>) {
    if problems.len() < MAX_PROBLEMS {
        problems.push(AnswerBlocksProblem {
            path: path.into(),
            fix: fix.into(),
        });
    }
}

pub(super) fn pointer(path: &str, key: &str) -> String {
    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"))
}

pub fn source_identity(source: &str) -> Option<String> {
    let url = Url::parse(source).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    Some(format!(
        "https://{}{}",
        url.host_str()?.to_lowercase(),
        url.path()
    ))
}

/// The page a URL shows, for matching one page across links that differ only
/// in scheme, a leading `www.`, query or fragment.
pub fn page_identity(source: &str) -> Option<String> {
    let identity = source_identity(source)?;
    Some(identity.replacen("https://www.", "https://", 1))
}

fn semantic(
    value: &Value,
    path: &str,
    context: &AnswerBlocksContext<'_>,
    read: &HashSet<String>,
    problems: &mut Vec<AnswerBlocksProblem>,
) {
    if problems.len() >= MAX_PROBLEMS {
        return;
    }
    match value {
        Value::Object(fields) => {
            provenance(value, path, context, read, problems);
            if let Some(img) = fields.get("img").and_then(Value::as_str)
                && !(context.image_exists)(img)
            {
                push(
                    problems,
                    &pointer(path, "img"),
                    "unknown image id; use an id returned by image_collect",
                );
            }
            dimensions(value, path, problems);
            for (key, field) in fields {
                semantic(field, &pointer(path, key), context, read, problems);
            }
        }
        Value::Array(items) => {
            unique(items, "key", path, problems);
            for (i, item) in items.iter().enumerate() {
                semantic(
                    item,
                    &pointer(path, &i.to_string()),
                    context,
                    read,
                    problems,
                );
            }
        }
        _ => {}
    }
}

fn provenance(
    value: &Value,
    path: &str,
    context: &AnswerBlocksContext<'_>,
    read: &HashSet<String>,
    problems: &mut Vec<AnswerBlocksProblem>,
) {
    let measured = value.get("value").is_some_and(Value::is_object);
    if measured {
        for key in ["source", "checked"] {
            if value.get(key).is_none() {
                push(
                    problems,
                    &pointer(path, key),
                    format!(
                        "required with value; give the {key} from reading its source, or drop value"
                    ),
                );
            }
        }
    }
    if let Some(checked) = value.get("checked").and_then(Value::as_str) {
        if let Ok(time) = DateTime::parse_from_rfc3339(checked)
            && time > context.now + Duration::minutes(5)
        {
            push(
                problems,
                &pointer(path, "checked"),
                "use the time the source was read, no later than now plus 5 minutes",
            );
        }
        if value.get("source").is_none() && !measured {
            push(
                problems,
                &pointer(path, "source"),
                "required with checked; give the URL read at that time",
            );
        }
    }
    if let Some(source) = value.get("source").and_then(Value::as_str) {
        let needs_read = measured
            || value.get("checked").is_some()
            || value.get("value").is_some()
            || value.get("series").is_some();
        if needs_read && source_identity(source).is_none_or(|id| !read.contains(&id)) {
            push(
                problems,
                &pointer(path, "source"),
                "source was not opened or read in this conversation; open and read it, or drop the sourced value",
            );
        }
    }
}

fn dimensions(value: &Value, path: &str, problems: &mut Vec<AnswerBlocksProblem>) {
    if value["type"] == "progress" {
        for (i, item) in value["items"].as_array().into_iter().flatten().enumerate() {
            progress(item, &format!("{path}/items/{i}"), problems);
        }
    }
    if let (Some(columns), Some(rows)) = (
        value.get("columns").and_then(Value::as_array),
        value.get("rows").and_then(Value::as_array),
    ) {
        for (i, row) in rows.iter().enumerate() {
            for (column, cell) in row.as_array().into_iter().flatten().enumerate() {
                if cell.as_str().is_some_and(|text| text.chars().count() > 60) {
                    push(
                        problems,
                        &format!("{path}/rows/{i}/{column}"),
                        "use at most 60 characters per cell; move longer detail to reply text",
                    );
                }
            }
            length(
                row,
                columns.len(),
                &format!("{path}/rows/{i}"),
                "columns",
                problems,
            );
        }
    }
    if let (Some(x), Some(series)) = (
        value.get("x").and_then(Value::as_array),
        value.get("series").and_then(Value::as_array),
    ) {
        for (i, item) in series.iter().enumerate() {
            if let Some(values) = item.get("values") {
                length(
                    values,
                    x.len(),
                    &format!("{path}/series/{i}/values"),
                    "x",
                    problems,
                );
            }
        }
    }
}

fn length(
    value: &Value,
    expected: usize,
    path: &str,
    field: &str,
    problems: &mut Vec<AnswerBlocksProblem>,
) {
    if let Some(items) = value.as_array()
        && items.len() != expected
    {
        push(
            problems,
            path,
            format!(
                "has {} entries; {field} has {expected}; supply exactly {expected} entries",
                items.len()
            ),
        );
    }
}

fn unique(items: &[Value], key: &str, path: &str, problems: &mut Vec<AnswerBlocksProblem>) {
    let mut seen = HashSet::new();
    for (i, item) in items.iter().enumerate() {
        if let Some(id) = item.get(key).and_then(Value::as_str)
            && !seen.insert(id)
        {
            push(
                problems,
                &format!("{path}/{i}/{key}"),
                format!("duplicate {key}; give each entry a distinct {key}"),
            );
        }
    }
}

/// Applies the exact final normalization to one closed field or item.
pub fn normalize_unit(value: &mut Value) {
    sets::trim(value);
    walk::defaults(value);
}

/// Checks a closed field/item against its block's schema and final evidence rules.
pub fn validate_draft_unit(
    block: &Value,
    field: &str,
    index: Option<usize>,
    value: &Value,
    context: &AnswerBlocksContext<'_>,
) -> bool {
    let Ok(contract) = CONTRACT.as_ref() else {
        return false;
    };
    let Some(variant) = schema::variant(block, &contract["$defs"]["block"], contract) else {
        return false;
    };
    let Some(mut rule) = variant["properties"].get(field) else {
        return false;
    };
    if let Some(index) = index {
        if rule["maxItems"]
            .as_u64()
            .is_some_and(|max| index as u64 >= max)
        {
            return false;
        }
        let Some(item_rule) = rule.get("items") else {
            return false;
        };
        rule = item_rule;
    }
    let mut problems = Vec::new();
    schema::validate(value, rule, contract, "", &mut problems);
    let read = context
        .read_sources
        .iter()
        .filter_map(|s| source_identity(s))
        .collect();
    if index.is_some() {
        if block["type"] == "progress" && field == "items" {
            progress(value, "", &mut problems);
        }
        semantic(value, "", context, &read, &mut problems);
    } else {
        let mut combined = block.clone();
        combined[field] = value.clone();
        semantic(&combined, "", context, &read, &mut problems);
    }
    if field == "rows" && index.is_some() {
        let columns = block["columns"].as_array().map_or(0, Vec::len);
        dimensions(
            &serde_json::json!({"columns": vec![Value::Null; columns], "rows": [value]}),
            "",
            &mut problems,
        );
    }
    problems.is_empty()
}

fn progress(item: &Value, path: &str, problems: &mut Vec<AnswerBlocksProblem>) {
    if let Some(value) = item["value"].as_f64()
        && value > item["max"].as_f64().unwrap_or(100.0)
    {
        push(
            problems,
            &pointer(path, "value"),
            "value must be at most max (default 100); correct value or max",
        );
    }
}
