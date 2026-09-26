use std::fs;
use std::path::{Path, PathBuf};

use crate::locale::LocaleCollation;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    DashboardLedgerRecord, DashboardLedgerSnapshot, DashboardLedgerSource, ProjectLedgerBinding,
    managed,
};
use crate::project_ledger::{ProjectLedgerReadError, committed, records};

pub(super) struct ExactRecord {
    pub(super) metadata: Value,
    pub(super) body: String,
    pub(super) revision: String,
}

pub(super) fn read_record(
    root: &Path,
    project_id: &str,
    target: &DashboardLedgerRecord,
) -> Result<ExactRecord, ProjectLedgerReadError> {
    let relative = target_relative(project_id, &target.path)?;
    reject_symlink_components(root, &relative)?;
    let relative = relative.to_str().ok_or(ProjectLedgerReadError::RecordShow(
        "project_ledger_exact_path_outside_root",
    ))?;
    let raw = committed::read_selected(root, relative)?.ok_or(
        ProjectLedgerReadError::RecordShow("dashboard_source_unavailable"),
    )?;
    let metadata = records::frontmatter(&raw).ok_or(ProjectLedgerReadError::RecordShow(
        "project_ledger_exact_frontmatter_corrupt",
    ))?;
    if metadata.get("id").and_then(Value::as_str) != Some(target.id.as_str())
        || metadata.get("kind").and_then(Value::as_str) != Some(target.kind.as_str())
        || metadata
            .get("parentId")
            .filter(|value| !value.is_null())
            .and_then(Value::as_str)
            != target.parent_id.as_deref()
    {
        return Err(ProjectLedgerReadError::RecordShow(
            "project_ledger_exact_record_metadata_mismatch",
        ));
    }
    Ok(ExactRecord {
        metadata,
        body: records::frontmatter_body(&raw),
        revision: format!("{:x}", Sha256::digest(raw.as_bytes())),
    })
}

pub(super) fn revalidate(
    root: &Path,
    project_id: &str,
    target: &DashboardLedgerRecord,
    revision: &str,
) -> Result<(), ProjectLedgerReadError> {
    let current = read_record(root, project_id, target)?;
    if current.revision != revision {
        return Err(ProjectLedgerReadError::RecordShow(
            "project_ledger_exact_record_hash_changed",
        ));
    }
    Ok(())
}

pub(super) fn read_source(
    root: &Path,
    binding: &ProjectLedgerBinding,
    snapshot: &DashboardLedgerSnapshot,
    kind: &str,
    id: &str,
    collation: &LocaleCollation,
) -> Result<DashboardLedgerSource, ProjectLedgerReadError> {
    let work = snapshot
        .works
        .iter()
        .find(|work| kind == "work" && work.record.id == id);
    let plan_work = snapshot.works.iter().find(|work| {
        kind == "plan"
            && work
                .managed
                .as_ref()
                .and_then(|managed| managed.current_plan.as_ref())
                .is_some_and(|plan| plan.id == id)
    });
    let mut matches = snapshot
        .records
        .iter()
        .filter(|record| record.kind == kind && record.id == id);
    let first = matches.next();
    if matches.next().is_some() {
        return Err(ProjectLedgerReadError::RecordShow(
            "dashboard_source_ambiguous",
        ));
    }
    let plan_target = plan_work.and_then(|work| {
        let plan = work.managed.as_ref()?.current_plan.as_ref()?;
        Some(DashboardLedgerRecord {
            id: id.to_owned(),
            kind: "plan".into(),
            title: plan.objective.clone(),
            status: work.record.status.clone(),
            path: format!(
                "project-ledger/projects/{}/plans/{}.md",
                binding.ledger_project_id,
                id.to_lowercase()
            ),
            parent_id: Some(work.record.id.clone()),
            spec: Some(managed::PROJECT_WORK_SPEC.into()),
            updated_at: plan.created_at.clone(),
            priority: 100.0,
            unavailable: false,
        })
    });
    let target = work
        .map(|work| &work.record)
        .or(plan_target.as_ref())
        .or(first)
        .ok_or(ProjectLedgerReadError::RecordShow(
            "dashboard_source_unavailable",
        ))?;
    if work.is_some_and(|work| work.availability != "ready") {
        return Err(ProjectLedgerReadError::RecordShow(
            "dashboard_source_unavailable",
        ));
    }
    let exact = read_record(root, &binding.ledger_project_id, target)?;
    if exact.metadata.get("schema").and_then(Value::as_str)
        != Some(format!("project-ledger.{kind}.v1").as_str())
    {
        return Err(ProjectLedgerReadError::RecordShow(
            "dashboard_source_unavailable",
        ));
    }
    let mut body = exact.body;
    let mut title = exact
        .metadata
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(&target.title)
        .to_owned();
    if let Some(work) = work.and_then(|work| work.managed.as_ref()) {
        if snapshot
            .works
            .iter()
            .find(|candidate| candidate.record.id == id)
            .and_then(|candidate| candidate.revision.as_deref())
            != Some(exact.revision.as_str())
        {
            return Err(ProjectLedgerReadError::RecordShow(
                "dashboard_source_changed",
            ));
        }
        title.clone_from(&work.objective);
        body = work.public_markdown();
    } else if kind == "plan"
        && exact.metadata.get("spec").and_then(Value::as_str) == Some(managed::PROJECT_WORK_SPEC)
    {
        let plan = managed::read_plan_child(
            root,
            binding,
            &plan_work
                .ok_or(ProjectLedgerReadError::RecordShow(
                    "dashboard_source_unavailable",
                ))?
                .record
                .id,
            id,
            collation,
        )?;
        title.clone_from(&plan.objective);
        body = plan.public_markdown();
    }
    revalidate(root, &binding.ledger_project_id, target, &exact.revision)?;
    Ok(DashboardLedgerSource {
        title,
        body,
        revision: exact.revision,
        document_type: kind.to_owned(),
        updated_at: exact
            .metadata
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or(&target.updated_at)
            .to_owned(),
        status: exact
            .metadata
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or(&target.status)
            .to_owned(),
    })
}

fn target_relative(
    project_id: &str,
    indexed_path: &str,
) -> Result<PathBuf, ProjectLedgerReadError> {
    let prefix = format!("project-ledger/projects/{project_id}/");
    let relative = indexed_path
        .strip_prefix(&prefix)
        .ok_or(ProjectLedgerReadError::RecordShow(
            "project_ledger_exact_path_outside_root",
        ))?;
    let path = Path::new(relative);
    if relative.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(ProjectLedgerReadError::RecordShow(
            "project_ledger_exact_path_outside_root",
        ));
    }
    Ok(path.to_path_buf())
}

fn reject_symlink_components(root: &Path, relative: &Path) -> Result<(), ProjectLedgerReadError> {
    let mut cursor = root.to_path_buf();
    for component in relative.components() {
        cursor.push(component);
        match fs::symlink_metadata(&cursor) {
            Ok(stat) if stat.file_type().is_symlink() => {
                return Err(ProjectLedgerReadError::RecordShow(
                    "project_ledger_exact_path_symlink",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => {
                return Err(ProjectLedgerReadError::RecordShow(
                    "project_ledger_record_io_error",
                ));
            }
        }
    }
    Ok(())
}
