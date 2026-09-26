//! Source record projection shared by index building and exact show.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};

use super::{CliFailure, display_path, io_failure};
use crate::project_ledger::records;

const NULL_FIELDS: &[(&str, &str)] = &[
    ("parentId", "parentId"),
    ("spec", "spec"),
    ("acceptance", "acceptance"),
    ("codeCommits", "codeCommits"),
    ("ledgerCommits", "ledgerCommits"),
    ("report", "report"),
    ("review", "review"),
    ("validation", "validation"),
    ("implementation", "implementation"),
    ("mitigation", "mitigation"),
    ("reason", "reason"),
];

pub(super) struct ProjectedRecord {
    pub value: Value,
    pub source_mtime_ms: f64,
}

pub(super) fn from_raw(
    root: &Path,
    relative: &Path,
    raw: &str,
) -> Result<Option<ProjectedRecord>, CliFailure> {
    let extension = relative.extension().and_then(|value| value.to_str());
    if !matches!(extension, Some("md" | "json")) || relative.ends_with("ledger.jsonl") {
        return Ok(None);
    }
    let path = root.join(relative);
    let metadata = fs::metadata(&path).map_err(|_| io_failure())?;
    let data = if extension == Some("json") {
        serde_json::from_str::<Value>(raw)
            .map_err(|_| CliFailure::new("invalid_json", "Invalid Project Ledger record JSON"))?
    } else {
        records::frontmatter(raw).unwrap_or_else(|| json!({}))
    };
    if data.is_null() || data == Value::Bool(false) {
        return Ok(None);
    }
    let kind = data
        .get("kind")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| infer_kind(relative));
    let filename_id = relative.file_stem().unwrap_or_default().to_string_lossy();
    let id = data
        .get("id")
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
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
        .unwrap_or_else(|| "unknown".into());
    let modified = metadata.modified().map_err(|_| io_failure())?;
    let elapsed = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|_| io_failure())?;
    let modified_at = DateTime::<Utc>::from(modified).to_rfc3339_opts(SecondsFormat::Millis, true);
    let updated_at = data
        .get("updatedAt")
        .filter(|value| !value.is_null())
        .map(js_string)
        .transpose()?
        .unwrap_or(modified_at);
    let priority = data
        .get("priority")
        .filter(|value| value.is_number())
        .cloned()
        .unwrap_or_else(|| json!(100));
    let mut value = json!({
        "id":id,
        "kind":kind,
        "title":title,
        "status":status,
        "priority":priority,
        "parentId":null,
        "spec":null,
        "specExemption":truthy(data.get("specExemption")),
        "acceptance":null,
        "acceptanceExemption":truthy(data.get("acceptanceExemption")),
        "requiresCommitEvidence":truthy(data.get("requiresCommitEvidence")),
        "codeCommits":null,
        "ledgerCommits":null,
        "report":null,
        "review":null,
        "validation":null,
        "implementation":null,
        "mitigation":null,
        "reason":null,
        "updatedAt":updated_at,
        "path":display_path(root, relative),
        "sourceMtimeMs":elapsed.as_secs_f64()*1000.0,
    });
    for &(source, output) in NULL_FIELDS {
        if let Some(text) = data.get(source).and_then(Value::as_str) {
            value[output] = Value::String(text.to_owned());
        }
    }
    Ok(Some(ProjectedRecord {
        value,
        source_mtime_ms: elapsed.as_secs_f64() * 1000.0,
    }))
}

pub(super) fn reference(record: &Value, reason: Option<&str>) -> Value {
    let mut result = json!({
        "id":record.get("id"),
        "kind":record.get("kind"),
        "title":record.get("title"),
        "status":record.get("status"),
        "path":record.get("path"),
    });
    if let Some(reason) = reason {
        result["reason"] = Value::String(reason.into());
    }
    result
}

fn infer_kind(relative: &Path) -> &'static str {
    let path = relative.to_string_lossy().replace('\\', "/");
    if path == "project.json" {
        "project"
    } else if path.starts_with("work/") && path.contains("/tasks/") && path.contains("/attempts/") {
        "attempt"
    } else if path.starts_with("work/") && path.contains("/tasks/") {
        "task"
    } else if path.starts_with("work/") {
        "work"
    } else {
        match path.split('/').next().unwrap_or("") {
            "initiatives" => "initiative",
            "decisions" => "decision",
            "risks" => "risk",
            "specs" => "spec",
            "reports" => "report",
            "plans" => "plan",
            "handoffs" => "handoff",
            "references" => "reference",
            "roadmaps" => "roadmap",
            _ => "record",
        }
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(value)) => value.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        _ => true,
    }
}

fn js_string(value: &Value) -> Result<String, CliFailure> {
    Ok(match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(_) => crate::json::stringify(value).map_err(|_| io_failure())?,
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
            return Err(io_failure());
        }
        Value::Object(_) => "[object Object]".into(),
    })
}
