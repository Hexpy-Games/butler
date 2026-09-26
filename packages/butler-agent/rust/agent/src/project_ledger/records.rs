use std::fs;
use std::path::Path;

use serde_json::{Map, Value};

use super::ProjectLedgerReadError;
use super::committed;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlanRecordShow {
    pub id: String,
    pub title: String,
    pub status: String,
    pub body: Option<String>,
    pub path: Option<String>,
}

pub(super) fn show_plan(
    _butler_data: &Path,
    root: &Path,
    original_id: &str,
) -> Result<PlanRecordShow, ProjectLedgerReadError> {
    let lookup = crate::public_text::trim_js_whitespace(original_id);
    if lookup.is_empty() {
        return Err(ProjectLedgerReadError::RecordShow("invalid_input"));
    }
    let mut matches = Vec::new();
    for (relative, raw) in committed::read_all(root)? {
        if !relative.ends_with(".md") && !relative.ends_with(".json") {
            continue;
        }
        if relative.ends_with("ledger.jsonl") {
            continue;
        }
        let Some(raw) = raw else { continue };
        let current = root.join(&relative);
        // readRecord observes the current file even when raw is a before-image.
        let stats = fs::metadata(&current)
            .map_err(|_| ProjectLedgerReadError::RecordShow("project_ledger_record_io_error"))?;
        let data = if relative.ends_with(".json") {
            serde_json::from_str::<Value>(&raw)
                .map_err(|_| ProjectLedgerReadError::RecordShow("invalid_record_json"))?
        } else {
            frontmatter(&raw).unwrap_or_else(|| Value::Object(Map::new()))
        };
        if js_falsy(&data) {
            continue;
        }
        let kind = data
            .get("kind")
            .and_then(Value::as_str)
            .filter(|kind| !kind.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| infer_kind(&relative).to_owned());
        let filename_id = current
            .file_stem()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let id = data
            .get("id")
            .and_then(Value::as_str)
            .map(crate::public_text::trim_js_whitespace)
            .filter(|id| !id.is_empty())
            .unwrap_or(&filename_id);
        let title = data
            .get("title")
            .filter(|value| !value.is_null())
            .or_else(|| data.get("name").filter(|value| !value.is_null()))
            .map(js_string)
            .transpose()?
            .unwrap_or_else(|| id.to_owned());
        let status = data
            .get("status")
            .filter(|value| !value.is_null())
            .map(js_string)
            .transpose()?
            .unwrap_or_else(|| "unknown".to_owned());
        if let Some(updated_at) = data.get("updatedAt").filter(|value| !value.is_null()) {
            js_string(updated_at)?;
        } else {
            let _ = stats.modified().map_err(|_| {
                ProjectLedgerReadError::RecordShow("project_ledger_record_io_error")
            })?;
        }
        if id != lookup || kind != "plan" {
            continue;
        }
        let path = format!(
            "project-ledger/projects/{}/{}",
            root.file_name().unwrap_or_default().to_string_lossy(),
            relative.replace('\\', "/")
        );
        let body = relative.ends_with(".md").then(|| frontmatter_body(&raw));
        matches.push(PlanRecordShow {
            id: id.to_owned(),
            title,
            status,
            body,
            path: Some(path),
        });
    }
    match matches.len() {
        0 => Err(ProjectLedgerReadError::RecordShow("record_not_found")),
        1 => Ok(matches.remove(0)),
        _ => Err(ProjectLedgerReadError::RecordShow("ambiguous_record")),
    }
}

fn infer_kind(relative: &str) -> &'static str {
    if relative == "project.json" {
        return "project";
    }
    if relative.starts_with("work/") {
        let segments: Vec<_> = relative.split('/').collect();
        if segments.len() >= 6 && segments[2] == "tasks" && segments[4] == "attempts" {
            return "attempt";
        }
        if segments.len() >= 4 && segments[2] == "tasks" {
            return "task";
        }
        return "work";
    }
    for (prefix, kind) in [
        ("initiatives/", "initiative"),
        ("decisions/", "decision"),
        ("risks/", "risk"),
        ("specs/", "spec"),
        ("reports/", "report"),
        ("plans/", "plan"),
        ("handoffs/", "handoff"),
        ("references/", "reference"),
        ("roadmaps/", "roadmap"),
    ] {
        if relative.starts_with(prefix) {
            return kind;
        }
    }
    "record"
}

pub(super) fn frontmatter(raw: &str) -> Option<Value> {
    let header = raw.strip_prefix("---\n")?;
    let end = header.find("\n---")?;
    let mut data = Map::new();
    for line in crate::public_text::trim_js_whitespace(&header[..end]).split('\n') {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            continue;
        }
        data.insert(key.to_owned(), scalar(value));
    }
    Some(Value::Object(data))
}

fn scalar(value: &str) -> Value {
    let raw = crate::public_text::trim_js_whitespace(value);
    if raw.starts_with('"') && raw.ends_with('"') {
        return serde_json::from_str(raw)
            .unwrap_or_else(|_| Value::String(raw[1..raw.len().saturating_sub(1)].to_owned()));
    }
    let trimmed = raw.strip_prefix('\'').unwrap_or(raw);
    let trimmed = trimmed.strip_suffix('\'').unwrap_or(trimmed);
    match trimmed {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        _ if !trimmed.is_empty()
            && (trimmed.bytes().all(|byte| byte.is_ascii_digit())
                || (trimmed.starts_with('-')
                    && trimmed.len() > 1
                    && trimmed[1..].bytes().all(|byte| byte.is_ascii_digit()))) =>
        {
            let number = crate::json::number_from_string(trimmed);
            serde_json::Number::from_f64(number)
                .map(Value::Number)
                .unwrap_or(Value::Null)
        }
        _ => Value::String(trimmed.to_owned()),
    }
}

pub(super) fn frontmatter_body(raw: &str) -> String {
    frontmatter_body_ref(raw).to_owned()
}

pub(super) fn frontmatter_body_ref(raw: &str) -> &str {
    let Some(header) = raw.strip_prefix("---\n") else {
        return raw;
    };
    let Some(end) = header.find("\n---") else {
        return raw;
    };
    let body = &header[end + 4..];
    body.strip_prefix("\n\n")
        .or_else(|| body.strip_prefix('\n'))
        .unwrap_or(body)
}

fn js_string(value: &Value) -> Result<String, ProjectLedgerReadError> {
    Ok(match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(_) => crate::json::stringify(value)
            .map_err(|_| ProjectLedgerReadError::RecordShow("invalid_record_value"))?,
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    Ok(String::new())
                } else {
                    js_string(value)
                }
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(","),
        Value::Object(object) if object.contains_key("toString") => {
            return Err(ProjectLedgerReadError::RecordShow("invalid_record_value"));
        }
        Value::Object(_) => "[object Object]".to_owned(),
    })
}

fn js_falsy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => true,
        Value::Number(number) => number.as_f64() == Some(0.0),
        Value::String(value) => value.is_empty(),
        _ => false,
    }
}
