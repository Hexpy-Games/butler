use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};

use super::super::contracts::{
    ProjectLedgerRecordKind, ProjectLedgerRecordOperation, ProjectLedgerRecordUpdate,
    ProjectWorkPublicationError,
};
use super::record_path;
use crate::project_ledger::records;

pub(super) fn apply(
    candidate: &Path,
    relative: &str,
    update: &ProjectLedgerRecordUpdate,
) -> Result<(), ProjectWorkPublicationError> {
    let path = record_path(candidate, relative)?;
    let kind = update.kind.as_ref().ok_or_else(invalid)?;
    let create = matches!(update.operation, Some(ProjectLedgerRecordOperation::Create));
    let existing = match fs::read_to_string(&path) {
        Ok(raw) => Some(raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(io()),
    };
    if create == existing.is_some() {
        return Err(ProjectWorkPublicationError::Adapter(if create {
            "record_exists"
        } else {
            "record_not_found"
        }));
    }
    let mut metadata = if let Some(raw) = existing.as_deref() {
        records::frontmatter(raw)
            .and_then(|value| value.as_object().cloned())
            .ok_or_else(invalid)?
    } else {
        let mut map = Map::new();
        map.insert(
            "schema".into(),
            Value::String(format!("project-ledger.{}.v1", kind.as_str())),
        );
        map.insert("kind".into(), Value::String(kind.as_str().into()));
        map.insert("id".into(), Value::String(update.id.clone()));
        map.insert(
            "title".into(),
            Value::String(required(update.title.as_deref())?.into()),
        );
        map.insert(
            "status".into(),
            Value::String(create_status(kind, update.status.as_deref())?.into()),
        );
        let now = now_iso()?;
        map.insert("createdAt".into(), Value::String(now.clone()));
        map.insert("updatedAt".into(), Value::String(now));
        map
    };
    if metadata.get("id").and_then(Value::as_str) != Some(&update.id)
        || metadata.get("kind").and_then(Value::as_str) != Some(kind.as_str())
    {
        return Err(invalid());
    }
    if kind == &ProjectLedgerRecordKind::Work {
        let target = update
            .status
            .as_deref()
            .unwrap_or_else(|| metadata.get("status").and_then(Value::as_str).unwrap_or(""));
        if !matches!(
            target,
            "proposed"
                | "scoped"
                | "specified"
                | "in_progress"
                | "review"
                | "done"
                | "blocked"
                | "cancelled"
        ) {
            return Err(invalid());
        }
        if existing.is_some() {
            let from = metadata.get("status").and_then(Value::as_str).unwrap_or("");
            work_transition(from, target)?;
        }
    }
    put_text(&mut metadata, "title", update.title.as_deref());
    put_text(&mut metadata, "status", update.status.as_deref());
    put_text(&mut metadata, "spec", update.spec.as_deref());
    put_text(&mut metadata, "parentId", update.parent_id.as_deref());
    put_text(&mut metadata, "acceptance", update.acceptance.as_deref());
    put_text(&mut metadata, "validation", update.validation.as_deref());
    put_text(&mut metadata, "review", update.review.as_deref());
    put_text(&mut metadata, "report", update.report.as_deref());
    put_text(
        &mut metadata,
        "implementation",
        update.implementation.as_deref(),
    );
    put_text(&mut metadata, "mitigation", update.mitigation.as_deref());
    put_text(&mut metadata, "reason", update.reason.as_deref());
    put_text(&mut metadata, "codeCommits", update.code_commits.as_deref());
    put_text(
        &mut metadata,
        "ledgerCommits",
        update.ledger_commits.as_deref(),
    );
    if let Some(value) = update.priority {
        metadata.insert(
            "priority".into(),
            serde_json::to_value(value).map_err(|_| invalid())?,
        );
    }
    if update.requires_commit_evidence == Some(true) {
        metadata.insert("requiresCommitEvidence".into(), Value::Bool(true));
    }
    if update.spec_exemption == Some(true)
        && metadata
            .get("spec")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        metadata.insert("specExemption".into(), Value::Bool(true));
    }
    metadata.insert("updatedAt".into(), Value::String(now_iso()?));
    let body = update.body.as_deref().or_else(|| {
        existing
            .as_deref()
            .map(records::frontmatter_body_ref)
            .filter(|body| !body.is_empty())
    });
    let fallback = format!(
        "# {}\n\nManaged by Project Ledger.",
        update.title.as_deref().unwrap_or(&update.id)
    );
    let body = body.unwrap_or(&fallback);
    let mut raw = String::from("---\n");
    for (key, value) in metadata {
        if value.is_null() || value.as_str() == Some("") {
            continue;
        }
        raw.push_str(&key);
        raw.push_str(": ");
        match value {
            Value::String(text) => {
                raw.push_str(&crate::json::stringify(&Value::String(text)).map_err(|_| invalid())?)
            }
            Value::Bool(value) => raw.push_str(if value { "true" } else { "false" }),
            Value::Number(value) => raw.push_str(&value.to_string()),
            _ => return Err(invalid()),
        }
        raw.push('\n');
    }
    raw.push_str("---\n\n");
    raw.push_str(body);
    fs::create_dir_all(path.parent().ok_or_else(invalid)?).map_err(|_| io())?;
    fs::write(path, raw).map_err(|_| io())
}

fn put_text(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value.into()));
    }
}

fn required(value: Option<&str>) -> Result<&str, ProjectWorkPublicationError> {
    value
        .filter(|value| !crate::public_text::trim_js_whitespace(value).is_empty())
        .ok_or_else(invalid)
}

fn create_status<'a>(
    kind: &ProjectLedgerRecordKind,
    status: Option<&'a str>,
) -> Result<&'a str, ProjectWorkPublicationError> {
    match kind {
        ProjectLedgerRecordKind::Work => status.ok_or_else(invalid),
        ProjectLedgerRecordKind::Plan => Ok(status.unwrap_or("active")),
        ProjectLedgerRecordKind::Reference => Ok(status.unwrap_or("active")),
        _ => Err(invalid()),
    }
}

fn work_transition(from: &str, to: &str) -> Result<(), ProjectWorkPublicationError> {
    if from == to {
        return Ok(());
    }
    let reachable = match from {
        "proposed" => !matches!(to, "proposed"),
        "scoped" => !matches!(to, "proposed" | "scoped"),
        "specified" => !matches!(to, "proposed" | "scoped" | "specified"),
        "in_progress" => matches!(to, "review" | "done" | "blocked" | "cancelled"),
        "review" => matches!(to, "done" | "in_progress" | "blocked" | "cancelled"),
        "blocked" => matches!(to, "in_progress" | "review" | "done" | "cancelled"),
        _ => false,
    };
    if reachable {
        Ok(())
    } else {
        Err(ProjectWorkPublicationError::Adapter("invalid_transition"))
    }
}

fn now_iso() -> Result<String, ProjectWorkPublicationError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| io())?;
    let date = DateTime::<Utc>::from_timestamp(elapsed.as_secs() as i64, elapsed.subsec_nanos())
        .ok_or_else(io)?;
    Ok(date.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

fn invalid() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::Adapter("project_work_record_update_invalid")
}

fn io() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::Io("project_ledger_record_io_error")
}
