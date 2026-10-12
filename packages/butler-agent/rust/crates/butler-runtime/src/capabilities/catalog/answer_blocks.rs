//! Structured answers: atomic validation against the bundled contract and turn evidence.

use std::{collections::HashSet, sync::LazyLock};

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::Value;
use url::Url;

#[path = "answer_blocks_schema.rs"]
mod schema;
#[path = "answer_blocks_sets.rs"]
mod sets;
pub use sets::{accept, normalize, shown, sources};

pub const ANSWER_BLOCKS_SCHEMA: &str = include_str!("answer-blocks.schema.json");
pub const MAX_SPEC_BYTES: usize = 24 * 1024;
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
            "spec exceeds 24 KB; move detail to reply text or send separate calls",
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
            unique(
                items,
                if path == "/blocks" { "id" } else { "key" },
                path,
                problems,
            );
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
    if let (Some(columns), Some(rows)) = (
        value.get("columns").and_then(Value::as_array),
        value.get("rows").and_then(Value::as_array),
    ) {
        for (i, row) in rows.iter().enumerate() {
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
