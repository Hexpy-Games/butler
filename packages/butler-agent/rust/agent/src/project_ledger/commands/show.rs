//! Exact source record lookup and optional body projection.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{CliFailure, CommandContext, io_failure, option_string, record};
use crate::project_ledger::committed;

pub(in crate::project_ledger) struct ResolvedRecord {
    pub path: PathBuf,
    pub relative: PathBuf,
    pub raw: String,
    pub record: Value,
}

pub(super) fn show(context: &CommandContext, options: &Value) -> Result<Value, CliFailure> {
    let id = option_string(options, "id")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliFailure::new("invalid_arguments", "Missing required option: --id"))?;
    let record = resolve_record(&context.root, id, option_string(options, "kind"))?;
    let mut result = record.record;
    if super::option_truthy(options, "body") {
        result["body"] = if record.relative.extension().is_some_and(|ext| ext == "md") {
            Value::String(crate::project_ledger::records::frontmatter_body(
                &record.raw,
            ))
        } else {
            Value::Null
        };
    }
    Ok(result)
}

pub(in crate::project_ledger) fn resolve_record(
    root: &Path,
    id: &str,
    kind: Option<&str>,
) -> Result<ResolvedRecord, CliFailure> {
    let mut matches = Vec::new();
    let mut paths = Vec::new();
    if root.join("project.json").exists() {
        paths.push(root.join("project.json"));
    }
    paths.extend(committed::record_files(root).map_err(|_| io_failure())?);
    for path in paths {
        let Some(record) = read_record_path(root, &path)? else {
            continue;
        };
        if record.record.get("id").and_then(Value::as_str) == Some(id)
            && kind
                .is_none_or(|kind| record.record.get("kind").and_then(Value::as_str) == Some(kind))
        {
            matches.push(record);
        }
    }
    match matches.len() {
        0 => {
            let mut error = CliFailure::new(
                "record_not_found",
                format!(
                    "{}record not found: {id}",
                    kind.map(|kind| format!("{kind} ")).unwrap_or_default()
                ),
            );
            error.details = Box::new(json!([{"id":id,"kind":kind}]));
            error.next = vec![
                json!({"command":if let Some(kind)=kind { format!("project-ledger record show --kind {kind} --id {id}") } else { format!("project-ledger record show --id {id}") },"reason":"Check the exact id and kind."}),
                json!({"command":format!("project-ledger query --kind {}",kind.unwrap_or("all")),"reason":"List existing records before retrying."}),
            ];
            Err(error)
        }
        1 => Ok(matches.remove(0)),
        _ => {
            let mut error =
                CliFailure::new("ambiguous_record", format!("Record id is ambiguous: {id}"));
            error.details = Box::new(Value::Array(matches.iter().map(|record| json!({"id":id,"kind":record.record.get("kind"),"path":record.record.get("path")})).collect()));
            error.next = matches.iter().filter_map(|record| record.record.get("kind").and_then(Value::as_str)).map(|kind| json!({"command":format!("project-ledger record show --kind {kind} --id {id}"),"reason":format!("Retry with --kind {kind}.")})).collect();
            Err(error)
        }
    }
}

pub(in crate::project_ledger) fn read_record_path(
    root: &Path,
    path: &Path,
) -> Result<Option<ResolvedRecord>, CliFailure> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| io_failure())?
        .to_path_buf();
    let relative_string = relative.to_str().ok_or_else(io_failure)?;
    let raw = committed::read_selected(root, relative_string).map_err(|_| io_failure())?;
    let Some(raw) = raw else { return Ok(None) };
    let projected = record::from_raw(root, &relative, &raw)?;
    let Some(projected) = projected else {
        return Ok(None);
    };
    Ok(Some(ResolvedRecord {
        path: path.to_path_buf(),
        relative,
        raw,
        record: projected.value,
    }))
}
