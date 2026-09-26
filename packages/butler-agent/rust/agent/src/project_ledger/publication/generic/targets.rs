use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::contracts::LedgerEffectError;
use super::digest;
use super::scope::LedgerScope;
use crate::project_ledger::publication::contracts::{ProjectWorkTarget, ProjectWorkTargetState};
use crate::project_ledger::publication::{
    ProjectLedgerRecordKind, ProjectLedgerRecordOperation, ProjectLedgerRecordUpdate,
};

struct IndexedRecord {
    id: String,
    kind: String,
    path: PathBuf,
    parent_id: Option<String>,
}

pub(super) fn capture(
    scope: &LedgerScope,
    updates: &[ProjectLedgerRecordUpdate],
) -> Result<Vec<ProjectWorkTarget>, LedgerEffectError> {
    let records = index_records(&scope.root)?;
    let mut targets = Vec::with_capacity(updates.len());
    let mut seen = HashSet::with_capacity(updates.len());
    for update in updates {
        let matches = records
            .iter()
            .filter(|record| {
                record.id == update.id
                    && update
                        .kind
                        .as_ref()
                        .is_none_or(|kind| record.kind == kind.as_str())
            })
            .collect::<Vec<_>>();
        let (kind, path, parent_id) = match matches.as_slice() {
            [record] => {
                let kind = match update.kind.clone() {
                    Some(kind) => kind,
                    None => kind_from(&record.kind).ok_or(LedgerEffectError::Uncertain)?,
                };
                (kind, record.path.clone(), record.parent_id.clone())
            }
            [] => absent(scope, &records, update)?,
            _ => return Err(LedgerEffectError::Uncertain),
        };
        let relative = path
            .strip_prefix(&scope.root)
            .map_err(|_| LedgerEffectError::Uncertain)?;
        let displayed = format!(
            "project-ledger/projects/{}/{}",
            scope.project_id,
            relative.to_string_lossy().replace('\\', "/")
        );
        if !seen.insert((kind.as_str(), update.id.as_str(), displayed.clone())) {
            return Err(LedgerEffectError::Uncertain);
        }
        no_symlink_components(&scope.root, &path)?;
        let (state, raw_record_sha256) = match fs::read(&path) {
            Ok(raw) => {
                let text = String::from_utf8_lossy(&raw);
                let data = crate::project_ledger::records::frontmatter(&text)
                    .ok_or(LedgerEffectError::Uncertain)?;
                if data.get("id").and_then(Value::as_str) != Some(update.id.as_str())
                    || data.get("kind").and_then(Value::as_str) != Some(kind.as_str())
                    || data.get("parentId").and_then(Value::as_str) != parent_id.as_deref()
                {
                    return Err(LedgerEffectError::Uncertain);
                }
                (ProjectWorkTargetState::Present, Some(digest::sha(&raw)))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (ProjectWorkTargetState::Absent, None)
            }
            Err(_) => return Err(LedgerEffectError::Uncertain),
        };
        targets.push(ProjectWorkTarget {
            id: update.id.clone(),
            kind,
            path: displayed,
            parent_id,
            state,
            raw_record_sha256,
        });
    }
    Ok(targets)
}

pub(super) fn revalidate(
    scope: &LedgerScope,
    targets: &[ProjectWorkTarget],
) -> Result<(), LedgerEffectError> {
    for target in targets {
        let prefix = format!("project-ledger/projects/{}/", scope.project_id);
        let relative = target
            .path
            .strip_prefix(&prefix)
            .ok_or(LedgerEffectError::Uncertain)?;
        if relative.is_empty()
            || relative.contains('\\')
            || relative
                .split('/')
                .any(|part| part.is_empty() || matches!(part, "." | ".."))
        {
            return Err(LedgerEffectError::Uncertain);
        }
        let path = scope.root.join(relative);
        no_symlink_components(&scope.root, &path)?;
        let raw = match fs::read(path) {
            Ok(raw) => Some(raw),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(LedgerEffectError::Uncertain),
        };
        match (&target.state, raw) {
            (ProjectWorkTargetState::Absent, None) => (),
            (ProjectWorkTargetState::Present, Some(raw))
                if target.raw_record_sha256.as_deref() == Some(digest::sha(&raw).as_str()) => {}
            _ => return Err(LedgerEffectError::NotApplied),
        }
    }
    Ok(())
}

fn index_records(root: &Path) -> Result<Vec<IndexedRecord>, LedgerEffectError> {
    let files = crate::project_ledger::committed::record_files(root)
        .map_err(|_| LedgerEffectError::Uncertain)?;
    let mut records = Vec::with_capacity(files.len());
    for path in files {
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let raw = fs::read_to_string(&path).map_err(|_| LedgerEffectError::Uncertain)?;
        let Some(data) = crate::project_ledger::records::frontmatter(&raw) else {
            continue;
        };
        let (Some(id), Some(kind)) = (
            data.get("id").and_then(Value::as_str),
            data.get("kind").and_then(Value::as_str),
        ) else {
            continue;
        };
        if kind_from(kind).is_none() {
            continue;
        }
        records.push(IndexedRecord {
            id: id.into(),
            kind: kind.into(),
            path,
            parent_id: data
                .get("parentId")
                .and_then(Value::as_str)
                .map(str::to_owned),
        });
    }
    Ok(records)
}

fn absent(
    scope: &LedgerScope,
    records: &[IndexedRecord],
    update: &ProjectLedgerRecordUpdate,
) -> Result<(ProjectLedgerRecordKind, PathBuf, Option<String>), LedgerEffectError> {
    if update.operation != Some(ProjectLedgerRecordOperation::Create) {
        return Err(LedgerEffectError::Uncertain);
    }
    let kind = update.kind.clone().ok_or(LedgerEffectError::Uncertain)?;
    safe_id(&update.id)?;
    let path = match kind {
        ProjectLedgerRecordKind::Work => scope.root.join("work").join(&update.id).join("work.md"),
        ProjectLedgerRecordKind::Task => {
            let parent = update
                .parent_id
                .as_deref()
                .ok_or(LedgerEffectError::Uncertain)?;
            safe_id(parent)?;
            scope
                .root
                .join("work")
                .join(parent)
                .join("tasks")
                .join(format!("{}.md", update.id))
        }
        ProjectLedgerRecordKind::Attempt => {
            let parent = update
                .parent_id
                .as_deref()
                .ok_or(LedgerEffectError::Uncertain)?;
            safe_id(parent)?;
            let tasks = records
                .iter()
                .filter(|record| record.kind == "task" && record.id == parent)
                .collect::<Vec<_>>();
            let [task] = tasks.as_slice() else {
                return Err(LedgerEffectError::Uncertain);
            };
            task.path
                .with_extension("")
                .join("attempts")
                .join(format!("{}.md", update.id))
        }
        _ => {
            let directory = match kind {
                ProjectLedgerRecordKind::Initiative => "initiatives",
                ProjectLedgerRecordKind::Decision => "decisions",
                ProjectLedgerRecordKind::Risk => "risks",
                ProjectLedgerRecordKind::Spec => "specs",
                ProjectLedgerRecordKind::Report => "reports",
                ProjectLedgerRecordKind::Plan => "plans",
                ProjectLedgerRecordKind::Handoff => "handoffs",
                ProjectLedgerRecordKind::Reference => "references",
                ProjectLedgerRecordKind::Roadmap => "roadmaps",
                _ => return Err(LedgerEffectError::Uncertain),
            };
            scope
                .root
                .join(directory)
                .join(format!("{}.md", update.id.to_lowercase()))
        }
    };
    Ok((kind, path, update.parent_id.clone()))
}

fn kind_from(value: &str) -> Option<ProjectLedgerRecordKind> {
    serde_json::from_value(Value::String(value.into())).ok()
}

fn safe_id(id: &str) -> Result<(), LedgerEffectError> {
    if id.is_empty() || matches!(id, "." | "..") || id.contains('/') || id.contains('\\') {
        return Err(LedgerEffectError::Uncertain);
    }
    Ok(())
}

fn no_symlink_components(root: &Path, path: &Path) -> Result<(), LedgerEffectError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| LedgerEffectError::Uncertain)?;
    let mut cursor = root.to_path_buf();
    for part in relative.components() {
        cursor.push(part);
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(LedgerEffectError::Uncertain);
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return Err(LedgerEffectError::Uncertain),
        }
    }
    Ok(())
}
