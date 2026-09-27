use std::fs;
use std::path::{Path, PathBuf};

use butler_core::locale::LocaleCollation;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    DashboardLedgerRecord, DashboardLedgerSnapshot, DashboardLedgerSource, DashboardLedgerWork,
    ProjectLedgerBinding, managed,
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
    let relative = relative
        .to_str()
        .ok_or(ProjectLedgerReadError::record_show(
            "project_ledger_exact_path_outside_root",
        ))?;
    let raw = committed::read_selected(root, relative)?.ok_or(
        ProjectLedgerReadError::record_show("dashboard_source_unavailable"),
    )?;
    let metadata = records::frontmatter(&raw).ok_or(ProjectLedgerReadError::record_show(
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
        return Err(ProjectLedgerReadError::record_show(
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
        return Err(ProjectLedgerReadError::record_show(
            "project_ledger_exact_record_hash_changed",
        ));
    }
    Ok(())
}

fn unavailable() -> ProjectLedgerReadError {
    ProjectLedgerReadError::record_show("dashboard_source_unavailable")
}

/// The snapshot record a dashboard source names: a Work, the current plan
/// of a managed Work, or exactly one indexed record.
struct SourceTarget<'a> {
    work: Option<&'a DashboardLedgerWork>,
    plan_work: Option<&'a DashboardLedgerWork>,
    record: DashboardLedgerRecord,
}

fn source_target<'a>(
    binding: &ProjectLedgerBinding,
    snapshot: &'a DashboardLedgerSnapshot,
    kind: &str,
    id: &str,
) -> Result<SourceTarget<'a>, ProjectLedgerReadError> {
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
        return Err(ProjectLedgerReadError::record_show(
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
    let record = work
        .map(|work| work.record.clone())
        .or(plan_target)
        .or_else(|| first.cloned())
        .ok_or_else(unavailable)?;
    if work.is_some_and(|work| work.availability != "ready") {
        return Err(unavailable());
    }
    Ok(SourceTarget {
        work,
        plan_work,
        record,
    })
}

/// One dashboard source document. Managed Work and plans show their public
/// projection, never the private manifest; the file must not change while
/// it is read.
pub(super) fn read_source(
    root: &Path,
    binding: &ProjectLedgerBinding,
    snapshot: &DashboardLedgerSnapshot,
    kind: &str,
    id: &str,
    collation: &LocaleCollation,
) -> Result<DashboardLedgerSource, ProjectLedgerReadError> {
    let SourceTarget {
        work,
        plan_work,
        record: target,
    } = source_target(binding, snapshot, kind, id)?;
    let exact = read_record(root, &binding.ledger_project_id, &target)?;
    if exact.metadata.get("schema").and_then(Value::as_str)
        != Some(format!("project-ledger.{kind}.v1").as_str())
    {
        return Err(unavailable());
    }
    let text = |key: &str, fallback: &str| {
        exact
            .metadata
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_owned()
    };
    let mut body = exact.body.clone();
    let mut title = text("title", &target.title);
    if let Some(work) = work.and_then(|work| work.managed.as_ref()) {
        let revision = snapshot
            .works
            .iter()
            .find(|candidate| candidate.record.id == id)
            .and_then(|candidate| candidate.revision.as_deref());
        if revision != Some(exact.revision.as_str()) {
            return Err(ProjectLedgerReadError::record_show(
                "dashboard_source_changed",
            ));
        }
        title.clone_from(&work.objective);
        body = work.public_markdown();
    } else if kind == "plan"
        && exact.metadata.get("spec").and_then(Value::as_str) == Some(managed::PROJECT_WORK_SPEC)
    {
        let work_id = &plan_work.ok_or_else(unavailable)?.record.id;
        let plan = managed::read_plan_child(root, binding, work_id, id, collation)?;
        title.clone_from(&plan.objective);
        body = plan.public_markdown();
    }
    revalidate(root, &binding.ledger_project_id, &target, &exact.revision)?;
    Ok(DashboardLedgerSource {
        title,
        body,
        document_type: kind.to_owned(),
        updated_at: text("updatedAt", &target.updated_at),
        status: text("status", &target.status),
        revision: exact.revision,
    })
}

fn target_relative(
    project_id: &str,
    indexed_path: &str,
) -> Result<PathBuf, ProjectLedgerReadError> {
    let prefix = format!("project-ledger/projects/{project_id}/");
    let relative =
        indexed_path
            .strip_prefix(&prefix)
            .ok_or(ProjectLedgerReadError::record_show(
                "project_ledger_exact_path_outside_root",
            ))?;
    let path = Path::new(relative);
    if relative.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(ProjectLedgerReadError::record_show(
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
                return Err(ProjectLedgerReadError::record_show(
                    "project_ledger_exact_path_symlink",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => {
                return Err(ProjectLedgerReadError::record_show(
                    "project_ledger_record_io_error",
                ));
            }
        }
    }
    Ok(())
}
