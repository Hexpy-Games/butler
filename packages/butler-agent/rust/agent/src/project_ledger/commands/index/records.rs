use std::fs;
use std::path::Path;

use serde_json::{Value, json};

use super::super::{CliFailure, io_failure, record};
use crate::project_ledger::committed;

pub(super) struct Records {
    pub projected: Vec<Value>,
    pub issues: Vec<Value>,
    pub max_mtime_ms: f64,
    pub project: Value,
}

pub(super) fn read(root: &Path) -> Result<Records, CliFailure> {
    let project_path = root.join("project.json");
    if !root.exists() {
        return Err(CliFailure::new(
            "not_initialized",
            "Project Ledger is not initialized",
        ));
    }
    if !project_path.exists() {
        return Err(CliFailure::new(
            "missing_project",
            "project.json is missing",
        ));
    }
    let project_raw = fs::read_to_string(&project_path).map_err(|_| io_failure())?;
    let project_json: Value = serde_json::from_str(&project_raw)
        .map_err(|_| CliFailure::new("invalid_json", "Invalid Project Ledger project JSON"))?;
    let mut projected = Vec::new();
    let mut issues = Vec::new();
    let mut max_mtime_ms = 0.0_f64;
    let mut source_rows = vec![("project.json".to_owned(), Some(project_raw))];
    source_rows.extend(committed::read_all(root).map_err(|_| io_failure())?);
    source_rows.sort_by(|a, b| a.0.cmp(&b.0));
    for (relative, raw) in source_rows {
        let Some(raw) = raw else { continue };
        match record::from_raw(root, Path::new(&relative), &raw) {
            Ok(Some(record)) => {
                max_mtime_ms = max_mtime_ms.max(record.source_mtime_ms);
                projected.push(record.value);
            }
            Ok(None) => {}
            Err(error) => issues.push(issue(
                "invalid_schema",
                "error",
                &format!("Cannot parse record: {}", error.message),
                &super::super::display_path(root, Path::new(&relative)),
                None,
            )),
        }
    }
    let by_id: std::collections::HashMap<_, _> = projected
        .iter()
        .filter_map(|record| {
            record
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id, record))
        })
        .collect();
    for record in &projected {
        issues.extend(super::validation::validate(record, &by_id));
    }
    let project = projected
        .iter()
        .find(|record| record.get("kind").and_then(Value::as_str) == Some("project"))
        .map(|record| {
            json!({
                "id":record.get("id"),
                "name":record.get("title"),
                "status":record.get("status"),
                "path":record.get("path"),
            })
        })
        .unwrap_or(project_json);
    Ok(Records {
        projected,
        issues,
        max_mtime_ms,
        project,
    })
}

pub(super) fn count(records: &[Value]) -> Value {
    let mut counts = json!({
        "records":records.len(),"initiative":0,"work":0,"task":0,"attempt":0,
        "decision":0,"risk":0,"spec":0,"report":0,"plan":0,
        "handoff":0,"reference":0,"roadmap":0,
    });
    for record in records {
        if let Some(kind) = record.get("kind").and_then(Value::as_str)
            && let Some(value) = counts.get(kind).and_then(Value::as_u64)
        {
            counts[kind] = json!(value + 1);
        }
    }
    counts
}

pub(super) fn issue(
    code: &str,
    severity: &str,
    message: &str,
    path: &str,
    record: Option<&Value>,
) -> Value {
    json!({
        "code":code,"severity":severity,"message":message,"path":path,
        "record":record.map(|record| record::reference(record, None)),
    })
}
