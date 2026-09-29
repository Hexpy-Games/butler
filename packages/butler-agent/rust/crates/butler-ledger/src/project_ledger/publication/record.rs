//! Addressed Project Ledger record capture and sparse candidate materialization.

mod head;
mod proof;
mod update;

use std::fs;
use std::path::{Path, PathBuf};

use butler_turn::btcc::ResolvedProjectWorkScope;

use super::contracts::{
    ProjectLedgerRecordKind, ProjectLedgerRecordUpdate, ProjectWorkPublicationError,
    ProjectWorkTarget,
};

pub(super) use head::{ProjectWorkHead, observe_core_head, observe_head, revalidate_target};

pub(super) fn resolve_scope(
    data_root: &Path,
    scope: ResolvedProjectWorkScope,
) -> Result<ResolvedProjectWorkScope, ProjectWorkPublicationError> {
    let actual =
        butler_platform::secure_fs::canonicalize(&scope.ledger_root).map_err(|source| {
            ProjectWorkPublicationError::adapter("project_work_scope_unavailable")
                .with_source(source)
        })?;
    if !crate::project_ledger::active_reference::safe_id(&scope.ledger_project_id) {
        return Err(ProjectWorkPublicationError::adapter(
            "project_work_scope_mismatch",
        ));
    }
    let expected =
        butler_platform::secure_fs::canonicalize(data_root.join("project-ledger/projects"))
            .map_err(|source| {
                ProjectWorkPublicationError::adapter("project_work_scope_unavailable")
                    .with_source(source)
            })?
            .join(&scope.ledger_project_id);
    if actual != expected
        || actual.file_name().and_then(|name| name.to_str()) != Some(&scope.ledger_project_id)
    {
        return Err(ProjectWorkPublicationError::adapter(
            "project_work_scope_mismatch",
        ));
    }
    if fs::symlink_metadata(actual.join("project.json"))
        .map_err(|source| {
            ProjectWorkPublicationError::adapter("project_work_scope_unavailable")
                .with_source(source)
        })?
        .file_type()
        .is_symlink()
    {
        return Err(ProjectWorkPublicationError::adapter(
            "project_work_scope_mismatch",
        ));
    }
    let project = fs::read(actual.join("project.json")).map_err(|source| {
        ProjectWorkPublicationError::adapter("project_work_scope_unavailable").with_source(source)
    })?;
    let project: serde_json::Value = serde_json::from_slice(&project).map_err(|source| {
        ProjectWorkPublicationError::adapter("project_work_scope_mismatch").with_source(source)
    })?;
    if project.get("id").and_then(serde_json::Value::as_str) != Some(&scope.ledger_project_id) {
        return Err(ProjectWorkPublicationError::adapter(
            "project_work_scope_mismatch",
        ));
    }
    Ok(ResolvedProjectWorkScope {
        ledger_root: actual,
        ..scope
    })
}

pub(super) fn capture(
    scope: &ResolvedProjectWorkScope,
    updates: &[ProjectLedgerRecordUpdate],
    collation: &butler_core::locale::LocaleCollation,
) -> Result<(ProjectWorkHead, Vec<ProjectWorkTarget>), ProjectWorkPublicationError> {
    let mut addressed = Vec::with_capacity(updates.len() * 2);
    for update in updates {
        addressed.push(target(scope, update)?);
    }
    for proof in proof::updates(updates, collation)? {
        addressed.push(target(scope, &proof)?);
    }
    let mut seen = std::collections::HashSet::with_capacity(addressed.len());
    if addressed
        .iter()
        .any(|target| !seen.insert(target.path.clone()))
    {
        return Err(ProjectWorkPublicationError::adapter(
            "project_ledger_exact_target_ambiguous",
        ));
    }
    for target in &mut addressed {
        let relative = relative(scope, &target.path)?;
        let raw = super::super::committed::read_selected(&scope.ledger_root, relative).map_err(
            |source| {
                ProjectWorkPublicationError::adapter("project_ledger_exact_read_failed")
                    .with_source(source)
            },
        )?;
        if let Some(raw) = raw {
            let metadata = super::super::records::frontmatter(&raw).ok_or(
                ProjectWorkPublicationError::adapter("project_ledger_exact_frontmatter_corrupt"),
            )?;
            if metadata.get("id").and_then(serde_json::Value::as_str) != Some(&target.id)
                || metadata.get("kind").and_then(serde_json::Value::as_str)
                    != Some(target.kind.as_str())
                || metadata.get("parentId").and_then(serde_json::Value::as_str)
                    != target.parent_id.as_deref()
            {
                return Err(ProjectWorkPublicationError::adapter(
                    "project_ledger_exact_record_metadata_mismatch",
                ));
            }
            target.state = super::contracts::ProjectWorkTargetState::Present;
            target.raw_record_sha256 = Some(head::sha(raw.as_bytes()));
        }
    }
    if addressed
        .get(updates.len()..)
        .unwrap_or_default()
        .iter()
        .any(|target| target.state != super::contracts::ProjectWorkTargetState::Absent)
    {
        return Err(ProjectWorkPublicationError::adapter(
            "project_work_publication_proof_invalid",
        ));
    }
    let mut paths = vec!["project.json".to_owned()];
    paths.extend(
        addressed
            .iter()
            .map(|target| relative(scope, &target.path).map(str::to_owned))
            .collect::<Result<Vec<_>, _>>()?,
    );
    paths.sort();
    paths.dedup();
    let head = head::observe_head(&scope.ledger_root, &paths)?;
    for target in &addressed {
        head::revalidate_target(scope, target)?;
    }
    Ok((head, addressed))
}

pub(super) fn target(
    scope: &ResolvedProjectWorkScope,
    update: &ProjectLedgerRecordUpdate,
) -> Result<ProjectWorkTarget, ProjectWorkPublicationError> {
    let kind = update.kind.ok_or(ProjectWorkPublicationError::adapter(
        "project_work_publication_kind_invalid",
    ))?;
    let id = safe_id(&update.id)?;
    let path = match kind {
        ProjectLedgerRecordKind::Work => {
            format!(
                "project-ledger/projects/{}/work/{id}/work.md",
                scope.ledger_project_id
            )
        }
        ProjectLedgerRecordKind::Plan => format!(
            "project-ledger/projects/{}/plans/{}.md",
            scope.ledger_project_id,
            id.to_lowercase()
        ),
        ProjectLedgerRecordKind::Reference => format!(
            "project-ledger/projects/{}/references/{}.md",
            scope.ledger_project_id,
            id.to_lowercase()
        ),
        _ => {
            return Err(ProjectWorkPublicationError::adapter(
                "project_work_publication_kind_invalid",
            ));
        }
    };
    Ok(ProjectWorkTarget {
        id: id.to_owned(),
        kind,
        path,
        parent_id: update.parent_id.clone(),
        state: super::contracts::ProjectWorkTargetState::Absent,
        raw_record_sha256: None,
    })
}

pub(super) fn relative<'a>(
    scope: &ResolvedProjectWorkScope,
    path: &'a str,
) -> Result<&'a str, ProjectWorkPublicationError> {
    path.strip_prefix(&format!(
        "project-ledger/projects/{}/",
        scope.ledger_project_id
    ))
    .ok_or(ProjectWorkPublicationError::adapter(
        "project_ledger_exact_path_outside_root",
    ))
}

pub(super) fn materialize(
    candidate: &Path,
    scope: &ResolvedProjectWorkScope,
    updates: &[ProjectLedgerRecordUpdate],
) -> Result<(), ProjectWorkPublicationError> {
    for update in updates {
        let target = target(scope, update)?;
        let relative = relative(scope, &target.path)?;
        update::apply(candidate, relative, update)?;
    }
    Ok(())
}

pub(super) fn safe_id(id: &str) -> Result<&str, ProjectWorkPublicationError> {
    if butler_core::public_text::trim_js_whitespace(id).is_empty()
        || matches!(id, "." | "..")
        || id.contains(['/', '\\'])
    {
        return Err(ProjectWorkPublicationError::adapter(
            "project_ledger_record_identity_invalid",
        ));
    }
    Ok(id)
}

pub(super) fn record_path(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, ProjectWorkPublicationError> {
    if relative.starts_with('/')
        || relative
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(ProjectWorkPublicationError::adapter(
            "invalid_publication_record_path",
        ));
    }
    let mut path = root.to_path_buf();
    for part in relative.split('/') {
        path.push(part);
        if path.exists()
            && fs::symlink_metadata(&path)
                .map_err(|source| {
                    ProjectWorkPublicationError::io("project_ledger_record_io_error")
                        .with_source(source)
                })?
                .file_type()
                .is_symlink()
        {
            return Err(ProjectWorkPublicationError::adapter(
                "publication_record_is_symlink",
            ));
        }
    }
    Ok(path)
}
