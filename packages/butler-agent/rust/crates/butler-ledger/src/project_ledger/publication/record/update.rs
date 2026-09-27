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

/// Creates or updates one record file in the publication candidate: the
/// update's fields are merged over the existing frontmatter (or a new one),
/// Work status moves are checked, and the file is rewritten.
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
        return Err(ProjectWorkPublicationError::adapter(if create {
            "record_exists"
        } else {
            "record_not_found"
        }));
    }
    let mut metadata = match existing.as_deref() {
        Some(raw) => records::frontmatter(raw)
            .and_then(|value| value.as_object().cloned())
            .ok_or_else(invalid)?,
        None => new_metadata(kind, update)?,
    };
    if metadata.get("id").and_then(Value::as_str) != Some(&update.id)
        || metadata.get("kind").and_then(Value::as_str) != Some(kind.as_str())
    {
        return Err(invalid());
    }
    if kind == &ProjectLedgerRecordKind::Work {
        check_work_status(&metadata, update, existing.is_some())?;
    }
    merge(&mut metadata, update)?;
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
    let raw = render(metadata, body.unwrap_or(&fallback))?;
    fs::create_dir_all(path.parent().ok_or_else(invalid)?)
        .map_err(|source| io().with_source(source))?;
    fs::write(path, raw).map_err(|source| io().with_source(source))
}

/// The frontmatter of a record being created.
fn new_metadata(
    kind: &ProjectLedgerRecordKind,
    update: &ProjectLedgerRecordUpdate,
) -> Result<Map<String, Value>, ProjectWorkPublicationError> {
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
    Ok(map)
}

/// A Work's target status is a Work status, reachable from its current one.
fn check_work_status(
    metadata: &Map<String, Value>,
    update: &ProjectLedgerRecordUpdate,
    exists: bool,
) -> Result<(), ProjectWorkPublicationError> {
    let current = metadata.get("status").and_then(Value::as_str).unwrap_or("");
    let target = update.status.as_deref().unwrap_or(current);
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
    if exists {
        work_transition(current, target)?;
    }
    Ok(())
}

/// Copies every field the update sets over the frontmatter.
fn merge(
    metadata: &mut Map<String, Value>,
    update: &ProjectLedgerRecordUpdate,
) -> Result<(), ProjectWorkPublicationError> {
    for (key, value) in [
        ("title", &update.title),
        ("status", &update.status),
        ("spec", &update.spec),
        ("parentId", &update.parent_id),
        ("acceptance", &update.acceptance),
        ("validation", &update.validation),
        ("review", &update.review),
        ("report", &update.report),
        ("implementation", &update.implementation),
        ("mitigation", &update.mitigation),
        ("reason", &update.reason),
        ("codeCommits", &update.code_commits),
        ("ledgerCommits", &update.ledger_commits),
    ] {
        put_text(metadata, key, value.as_deref());
    }
    if let Some(value) = update.priority {
        metadata.insert(
            "priority".into(),
            serde_json::to_value(value).map_err(|source| invalid().with_source(source))?,
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
    Ok(())
}

/// The record file: non-empty frontmatter scalars, then the body.
fn render(metadata: Map<String, Value>, body: &str) -> Result<String, ProjectWorkPublicationError> {
    let mut raw = String::from("---\n");
    for (key, value) in metadata {
        if value.is_null() || value.as_str() == Some("") {
            continue;
        }
        raw.push_str(&key);
        raw.push_str(": ");
        match value {
            Value::String(text) => {
                raw.push_str(
                    &butler_core::json::stringify(&Value::String(text))
                        .map_err(|source| invalid().with_source(source))?,
                );
            }
            Value::Bool(value) => raw.push_str(if value { "true" } else { "false" }),
            Value::Number(value) => raw.push_str(&value.to_string()),
            _ => return Err(invalid()),
        }
        raw.push('\n');
    }
    raw.push_str("---\n\n");
    raw.push_str(body);
    Ok(raw)
}

fn put_text(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value.into()));
    }
}

fn required(value: Option<&str>) -> Result<&str, ProjectWorkPublicationError> {
    value
        .filter(|value| !butler_core::public_text::trim_js_whitespace(value).is_empty())
        .ok_or_else(invalid)
}

fn create_status<'a>(
    kind: &ProjectLedgerRecordKind,
    status: Option<&'a str>,
) -> Result<&'a str, ProjectWorkPublicationError> {
    match kind {
        ProjectLedgerRecordKind::Work => status.ok_or_else(invalid),
        ProjectLedgerRecordKind::Plan | ProjectLedgerRecordKind::Reference => {
            Ok(status.unwrap_or("active"))
        }
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
        Err(ProjectWorkPublicationError::adapter("invalid_transition"))
    }
}

fn now_iso() -> Result<String, ProjectWorkPublicationError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|source| io().with_source(source))?;
    let date = DateTime::<Utc>::from_timestamp(
        i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX),
        elapsed.subsec_nanos(),
    )
    .ok_or_else(io)?;
    Ok(date.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

fn invalid() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::adapter("project_work_record_update_invalid")
}

fn io() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::io("project_ledger_record_io_error")
}
