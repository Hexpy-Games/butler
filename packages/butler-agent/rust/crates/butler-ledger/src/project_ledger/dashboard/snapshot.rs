use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use butler_core::locale::LocaleCollation;
use butler_platform::secure_fs;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    DashboardLedgerRecord, DashboardLedgerSnapshot, DashboardLedgerWork, ProjectLedgerBinding,
};
use super::{exact, managed};
use crate::project_ledger::{ProjectLedgerReadError, committed};

/// A consistent dashboard snapshot: indexed records plus every Work on disk,
/// refreshed from their sources. Retried once when the ledger changes while
/// it is read.
pub(super) fn read(
    root: &Path,
    binding: &ProjectLedgerBinding,
    collation: &LocaleCollation,
) -> Result<DashboardLedgerSnapshot, ProjectLedgerReadError> {
    for _ in 0..2 {
        if let Some(snapshot) = observe(root, binding, collation)? {
            return Ok(snapshot);
        }
    }
    Err(ProjectLedgerReadError::record_show(
        "dashboard_ledger_changing",
    ))
}

/// One attempt; `None` when the publication, index or sources changed.
fn observe(
    root: &Path,
    binding: &ProjectLedgerBinding,
    collation: &LocaleCollation,
) -> Result<Option<DashboardLedgerSnapshot>, ProjectLedgerReadError> {
    let publication = committed::publication_version(root)?;
    let raw_index = fs::read_to_string(root.join("index/project.json"))
        .map_err(|source| invalid_index().with_source(source))?;
    let mut records = indexed_records(&raw_index, &binding.ledger_project_id)?;
    let metadata = source_metadata(root, &records)?;
    let revision = format!(
        "{:x}",
        Sha256::digest(format!(
            "{}\0{}\0{}\0{}\0{}",
            binding.app_project_id, binding.ledger_project_id, publication, raw_index, metadata
        ))
    );
    add_unindexed_works(root, binding, &mut records)?;
    for record in &mut records {
        if record.kind != "work" {
            refresh_record(root, binding, record)?;
        }
    }
    let works = records
        .iter()
        .filter(|record| record.kind == "work")
        .map(|record| work(root, binding, record, collation))
        .collect::<Vec<_>>();
    if publication != committed::publication_version(root)?
        || raw_index
            != fs::read_to_string(root.join("index/project.json"))
                .map_err(|source| invalid_index().with_source(source))?
        || metadata != source_metadata(root, &records)?
    {
        return Ok(None);
    }
    merge_works(binding, &mut records, &works);
    Ok(Some(DashboardLedgerSnapshot {
        revision,
        observed_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        records,
        works,
    }))
}

/// Work directories the index does not list yet, as placeholder records.
fn add_unindexed_works(
    root: &Path,
    binding: &ProjectLedgerBinding,
    records: &mut Vec<DashboardLedgerRecord>,
) -> Result<(), ProjectLedgerReadError> {
    for id in work_ids(root)? {
        if records
            .iter()
            .any(|record| record.kind == "work" && record.id == id)
        {
            continue;
        }
        records.push(DashboardLedgerRecord {
            path: format!(
                "project-ledger/projects/{}/work/{id}/work.md",
                binding.ledger_project_id
            ),
            id: id.clone(),
            kind: "work".into(),
            title: id,
            status: "unknown".into(),
            parent_id: None,
            spec: None,
            updated_at: String::new(),
            priority: 100.0,
            unavailable: false,
        });
    }
    Ok(())
}

/// Marks a missing or irregular record unavailable, and refreshes an
/// unmanaged task or plan's title, status and update time from its source.
fn refresh_record(
    root: &Path,
    binding: &ProjectLedgerBinding,
    record: &mut DashboardLedgerRecord,
) -> Result<(), ProjectLedgerReadError> {
    let relative = relative_record_path(&record.path)?;
    let regular = fs::symlink_metadata(root.join(relative))
        .is_ok_and(|stat| stat.is_file() && !stat.file_type().is_symlink());
    if !regular {
        mark_unavailable(record);
        return Ok(());
    }
    if !matches!(record.kind.as_str(), "task" | "plan")
        || record.spec.as_deref() == Some(managed::PROJECT_WORK_SPEC)
    {
        return Ok(());
    }
    let Ok(source) = exact::read_record(root, &binding.ledger_project_id, record) else {
        mark_unavailable(record);
        return Ok(());
    };
    let schema = format!("project-ledger.{}.v1", record.kind);
    let metadata = &source.metadata;
    let (Some(title), Some(status)) = (
        metadata.get("title").and_then(Value::as_str),
        metadata.get("status").and_then(Value::as_str),
    ) else {
        mark_unavailable(record);
        return Ok(());
    };
    if metadata.get("schema").and_then(Value::as_str) != Some(schema.as_str()) {
        mark_unavailable(record);
        return Ok(());
    }
    record.title = title.to_owned();
    record.status = status.to_owned();
    if let Some(updated) = metadata.get("updatedAt") {
        record.updated_at = js_string(updated);
    }
    Ok(())
}

fn mark_unavailable(record: &mut DashboardLedgerRecord) {
    record.status = "unknown".into();
    record.unavailable = true;
}

/// A Work record read from its source, with its managed view when it is
/// Project Work; unavailable when its source does not read.
fn work(
    root: &Path,
    binding: &ProjectLedgerBinding,
    record: &DashboardLedgerRecord,
    collation: &LocaleCollation,
) -> DashboardLedgerWork {
    match resolve_work(root, binding, record, collation) {
        Ok((record, revision, managed)) => DashboardLedgerWork {
            record,
            revision: Some(revision),
            availability: "ready",
            managed,
        },
        Err(_) => DashboardLedgerWork {
            record: record.clone(),
            revision: None,
            availability: "unavailable",
            managed: None,
        },
    }
}

type ResolvedWork = (
    DashboardLedgerRecord,
    String,
    Option<super::DashboardManagedWorkView>,
);

fn resolve_work(
    root: &Path,
    binding: &ProjectLedgerBinding,
    record: &DashboardLedgerRecord,
    collation: &LocaleCollation,
) -> Result<ResolvedWork, ProjectLedgerReadError> {
    let source = exact::read_record(root, &binding.ledger_project_id, record)?;
    let metadata = &source.metadata;
    if metadata.get("schema").and_then(Value::as_str) != Some("project-ledger.work.v1") {
        return Err(invalid_index());
    }
    let text = |key: &str| metadata.get(key).and_then(Value::as_str);
    let title = text("title").ok_or_else(invalid_index)?;
    let status = text("status").ok_or_else(invalid_index)?;
    let mut current = record.clone();
    current.title = title.into();
    current.status = status.into();
    current.spec = text("spec").map(str::to_owned);
    if let Some(updated) = metadata.get("updatedAt") {
        current.updated_at = js_string(updated);
    }
    let managed = if current.spec.as_deref() == Some(managed::PROJECT_WORK_SPEC) {
        Some(managed::read_current(
            root, binding, &current, &source, collation,
        )?)
    } else {
        None
    };
    Ok((current, source.revision, managed))
}

/// Replaces indexed Work records with their resolved form and adds each
/// managed Work's current plan when the index does not list it.
fn merge_works(
    binding: &ProjectLedgerBinding,
    records: &mut Vec<DashboardLedgerRecord>,
    works: &[DashboardLedgerWork],
) {
    for work in works {
        if let Some(slot) = records
            .iter_mut()
            .find(|record| record.kind == "work" && record.id == work.record.id)
        {
            *slot = work.record.clone();
        }
        let Some(plan) = work
            .managed
            .as_ref()
            .and_then(|managed| managed.current_plan.as_ref())
        else {
            continue;
        };
        if records
            .iter()
            .any(|record| record.kind == "plan" && record.id == plan.id)
        {
            continue;
        }
        records.push(DashboardLedgerRecord {
            id: plan.id.clone(),
            kind: "plan".into(),
            title: plan.objective.clone(),
            status: "active".into(),
            parent_id: Some(work.record.id.clone()),
            spec: Some(managed::PROJECT_WORK_SPEC.into()),
            path: format!(
                "project-ledger/projects/{}/plans/{}.md",
                binding.ledger_project_id,
                plan.id.to_lowercase()
            ),
            updated_at: plan.created_at.clone(),
            priority: 100.0,
            unavailable: false,
        });
    }
}

fn indexed_records(
    raw: &str,
    project_id: &str,
) -> Result<Vec<DashboardLedgerRecord>, ProjectLedgerReadError> {
    let index: Value =
        serde_json::from_str(raw).map_err(|source| invalid_index().with_source(source))?;
    if index.get("schema").and_then(Value::as_str) != Some("project-ledger.index.v1")
        || index.pointer("/project/id").and_then(Value::as_str) != Some(project_id)
    {
        return Err(invalid_index());
    }
    let entries = index
        .get("records")
        .and_then(Value::as_array)
        .ok_or_else(invalid_index)?;
    let prefix = format!("project-ledger/projects/{project_id}/");
    let mut keys = HashSet::new();
    let mut records = Vec::with_capacity(entries.len());
    for value in entries {
        let Some(kind) = value.get("kind").and_then(Value::as_str) else {
            continue;
        };
        if !matches!(kind, "work" | "task" | "plan" | "spec" | "report") {
            continue;
        }
        let string = |field| {
            value
                .get(field)
                .and_then(Value::as_str)
                .ok_or_else(invalid_index)
        };
        let id = string("id")?;
        let title = string("title")?;
        let status = string("status")?;
        let path = string("path")?;
        let updated_at = string("updatedAt")?;
        if !path.starts_with(&prefix) || path.split(['/', '\\']).any(|part| part == "..") {
            return Err(invalid_index());
        }
        let parent_id = match value.get("parentId") {
            Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value.clone()),
            _ => return Err(invalid_index()),
        };
        if !keys.insert(format!("{kind}\0{id}")) {
            return Err(ProjectLedgerReadError::record_show(
                "dashboard_index_ambiguous",
            ));
        }
        records.push(DashboardLedgerRecord {
            id: id.into(),
            kind: kind.into(),
            title: title.into(),
            status: status.into(),
            path: path.into(),
            parent_id,
            spec: value.get("spec").and_then(Value::as_str).map(str::to_owned),
            updated_at: updated_at.into(),
            priority: value
                .get("priority")
                .and_then(Value::as_f64)
                .unwrap_or(100.0),
            unavailable: false,
        });
    }
    Ok(records)
}

fn source_metadata(
    root: &Path,
    records: &[DashboardLedgerRecord],
) -> Result<String, ProjectLedgerReadError> {
    let mut paths = records
        .iter()
        .map(|record| relative_record_path(&record.path).map(Path::to_path_buf))
        .collect::<Result<Vec<_>, _>>()?;
    paths.extend(
        work_ids(root)?
            .into_iter()
            .map(|id| PathBuf::from(format!("work/{id}/work.md"))),
    );
    for directory in ["plans", "references"] {
        let dir = root.join(directory);
        if dir.exists() {
            for entry in fs::read_dir(&dir).map_err(|source| invalid_index().with_source(source))? {
                paths.push(
                    PathBuf::from(directory).join(
                        entry
                            .map_err(|source| invalid_index().with_source(source))?
                            .file_name(),
                    ),
                );
            }
        }
    }
    paths.sort_by(|left, right| {
        left.to_string_lossy()
            .encode_utf16()
            .cmp(right.to_string_lossy().encode_utf16())
    });
    paths.dedup();
    let values = paths
        .iter()
        .map(|path| {
            let path_string = path.to_string_lossy();
            let stat = fs::symlink_metadata(root.join(path)).ok();
            let (inode, size, mtime, ctime) = stat.as_ref().map_or(
                (Value::Null, Value::Null, Value::Null, Value::Null),
                |stat| {
                    let (inode, ctime) = stat_identity(stat);
                    let mtime = stat.modified().ok().map(js_time).unwrap_or(Value::Null);
                    (json!(inode), json!(stat.len()), mtime, ctime)
                },
            );
            json!([path_string.as_ref(), inode, size, mtime, ctime])
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&values).map_err(|source| invalid_index().with_source(source))
}

fn work_ids(root: &Path) -> Result<Vec<String>, ProjectLedgerReadError> {
    let directory = root.join("work");
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(invalid_index()),
    };
    let mut ids = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| invalid_index().with_source(source))?;
        if entry
            .file_type()
            .map_err(|source| invalid_index().with_source(source))?
            .is_dir()
        {
            ids.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    ids.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    Ok(ids)
}

fn relative_record_path(indexed: &str) -> Result<&Path, ProjectLedgerReadError> {
    let mut parts = indexed.splitn(4, '/');
    if parts.next() != Some("project-ledger")
        || parts.next() != Some("projects")
        || parts.next().is_none()
    {
        return Err(invalid_index());
    }
    parts.next().map(Path::new).ok_or_else(invalid_index)
}

fn js_time(value: std::time::SystemTime) -> Value {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map_or(Value::Null, |duration| {
            json!(
                duration.as_secs() as f64 * 1000.0
                    + f64::from(duration.subsec_nanos()) / 1_000_000.0
            )
        })
}

/// The inode and the status change time in epoch milliseconds (or `null`).
fn stat_identity(stat: &fs::Metadata) -> (u64, Value) {
    let identity = secure_fs::identity(stat);
    (
        identity.inode,
        identity
            .changed
            .map_or(Value::Null, |changed| json!(changed.millis())),
    )
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        _ => value.to_string(),
    }
}

fn invalid_index() -> ProjectLedgerReadError {
    ProjectLedgerReadError::record_show("dashboard_index_invalid")
}
