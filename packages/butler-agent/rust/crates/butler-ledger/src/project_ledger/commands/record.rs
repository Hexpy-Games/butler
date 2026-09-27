//! Source record projection shared by index building and exact show.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Value, json};

use super::{CliFailure, display_path, io_failure};
use crate::project_ledger::records;

pub(super) struct ProjectedRecord {
    pub value: Value,
    pub source_mtime_ms: f64,
}

/// One source record as the compact index lists it. Field order is the
/// index's JSON order; optional text fields are `null` when absent.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexRecord<'a> {
    id: &'a str,
    kind: &'a str,
    title: String,
    status: String,
    priority: Value,
    parent_id: Option<&'a str>,
    spec: Option<&'a str>,
    spec_exemption: bool,
    acceptance: Option<&'a str>,
    acceptance_exemption: bool,
    requires_commit_evidence: bool,
    code_commits: Option<&'a str>,
    ledger_commits: Option<&'a str>,
    report: Option<&'a str>,
    review: Option<&'a str>,
    validation: Option<&'a str>,
    implementation: Option<&'a str>,
    mitigation: Option<&'a str>,
    reason: Option<&'a str>,
    updated_at: String,
    path: String,
    source_mtime_ms: f64,
}

/// The index projection of one `.md` or `.json` record file, or `None` for
/// other files and records whose data is `null`/`false`.
pub(super) fn from_raw(
    root: &Path,
    relative: &Path,
    raw: &str,
) -> Result<Option<ProjectedRecord>, CliFailure> {
    let extension = relative.extension().and_then(|value| value.to_str());
    if !matches!(extension, Some("md" | "json")) || relative.ends_with("ledger.jsonl") {
        return Ok(None);
    }
    let metadata =
        fs::metadata(root.join(relative)).map_err(|source| io_failure().with_source(source))?;
    let data = if extension == Some("json") {
        serde_json::from_str::<Value>(raw).map_err(|source| {
            CliFailure::new("invalid_json", "Invalid Project Ledger record JSON")
                .with_source(source)
        })?
    } else {
        records::frontmatter(raw).unwrap_or_else(|| json!({}))
    };
    if data.is_null() || data == Value::Bool(false) {
        return Ok(None);
    }
    let filename_id = relative.file_stem().unwrap_or_default().to_string_lossy();
    let id = data
        .get("id")
        .and_then(Value::as_str)
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .unwrap_or(&filename_id);
    let modified = metadata
        .modified()
        .map_err(|source| io_failure().with_source(source))?;
    let source_mtime_ms = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|source| io_failure().with_source(source))?
        .as_secs_f64()
        * 1000.0;
    let modified_at = DateTime::<Utc>::from(modified).to_rfc3339_opts(SecondsFormat::Millis, true);
    let record = project(&data, relative, id, modified_at, source_mtime_ms, root)?;
    let value = serde_json::to_value(record).map_err(|source| io_failure().with_source(source))?;
    Ok(Some(ProjectedRecord {
        value,
        source_mtime_ms,
    }))
}

/// The record's index fields; text a Bun reader would coerce is coerced the
/// same way.
fn project<'a>(
    data: &'a Value,
    relative: &Path,
    id: &'a str,
    modified_at: String,
    source_mtime_ms: f64,
    root: &Path,
) -> Result<IndexRecord<'a>, CliFailure> {
    let present = |key: &str| data.get(key).filter(|value| !value.is_null());
    let coerced = |key: &str| present(key).map(js_string).transpose();
    let text = |key: &str| data.get(key).and_then(Value::as_str);
    let title = match coerced("title")? {
        Some(title) => Some(title),
        None => coerced("name")?,
    };
    Ok(IndexRecord {
        id,
        kind: text("kind")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| infer_kind(relative)),
        title: title.unwrap_or_else(|| id.to_owned()),
        status: coerced("status")?.unwrap_or_else(|| "unknown".into()),
        priority: data
            .get("priority")
            .filter(|value| value.is_number())
            .cloned()
            .unwrap_or_else(|| json!(100)),
        parent_id: text("parentId"),
        spec: text("spec"),
        spec_exemption: truthy(data.get("specExemption")),
        acceptance: text("acceptance"),
        acceptance_exemption: truthy(data.get("acceptanceExemption")),
        requires_commit_evidence: truthy(data.get("requiresCommitEvidence")),
        code_commits: text("codeCommits"),
        ledger_commits: text("ledgerCommits"),
        report: text("report"),
        review: text("review"),
        validation: text("validation"),
        implementation: text("implementation"),
        mitigation: text("mitigation"),
        reason: text("reason"),
        updated_at: coerced("updatedAt")?.unwrap_or(modified_at),
        path: display_path(root, relative),
        source_mtime_ms,
    })
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
        crate::project_ledger::work_json::set_field(
            &mut result,
            "reason",
            Value::String(reason.into()),
        );
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
        Value::Number(_) => butler_core::json::stringify(value)
            .map_err(|source| io_failure().with_source(source))?,
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
