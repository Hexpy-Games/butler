use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::btcc::ResolvedProjectWorkScope;
use crate::locale::LocaleCollation;

use super::super::super::publication::{
    ProjectLedgerRecordKind, ProjectLedgerRecordUpdate, ProjectWorkPublicationError,
};
use super::super::super::{dashboard, records};
use super::{child_refs, dependencies, hydrate};

pub(in crate::project_ledger) fn validate_publication_candidate(
    candidate_root: &Path,
    canonical_root: &Path,
    scope: &ResolvedProjectWorkScope,
    updates: &[ProjectLedgerRecordUpdate],
    collation: &LocaleCollation,
) -> Result<(), ProjectWorkPublicationError> {
    let ids = updates
        .iter()
        .filter_map(|update| match update.kind.as_ref() {
            Some(ProjectLedgerRecordKind::Work) => Some(update.id.clone()),
            Some(ProjectLedgerRecordKind::Plan | ProjectLedgerRecordKind::Reference) => {
                update.parent_id.clone()
            }
            Some(_) | None => None,
        })
        .collect::<HashSet<_>>();
    for id in ids {
        let path = format!("work/{id}/work.md");
        let raw = candidate_or_committed(candidate_root, canonical_root, &path)?.ok_or(
            ProjectWorkPublicationError::Adapter("project_work_managed_record_invalid"),
        )?;
        let manifest = dashboard::decode_manifest_body(
            records::frontmatter_body_ref(&raw),
            &id,
            &scope.app_project_id,
            &scope.ledger_project_id,
            collation,
        )
        .map_err(|_| ProjectWorkPublicationError::Adapter("project_work_managed_record_invalid"))?;
        let refs = child_refs(&manifest).map_err(|_| {
            ProjectWorkPublicationError::Adapter("project_work_managed_record_invalid")
        })?;
        let mut children = HashMap::with_capacity(refs.len());
        for (child_id, kind, schema) in refs {
            let path = if kind == "plan" {
                format!("plans/{}.md", child_id.to_lowercase())
            } else {
                format!("references/{}.md", child_id.to_lowercase())
            };
            let raw = candidate_or_committed(candidate_root, canonical_root, &path)?.ok_or(
                ProjectWorkPublicationError::Adapter("project_work_managed_record_invalid"),
            )?;
            let child = dashboard::decode_child_body(
                records::frontmatter_body_ref(&raw),
                &id,
                &child_id,
                schema,
                collation,
            )
            .map_err(|_| {
                ProjectWorkPublicationError::Adapter("project_work_managed_record_invalid")
            })?;
            children.insert(child_id, child);
        }
        let dependencies =
            dependencies::refs(&manifest, &children).map_err(ProjectWorkPublicationError::Work)?;
        for (child_id, kind, schema) in dependencies {
            if let Some(existing) = children.get(&child_id) {
                if existing.get("schema").and_then(Value::as_str) != Some(schema) {
                    return Err(ProjectWorkPublicationError::Adapter(
                        "project_work_managed_record_invalid",
                    ));
                }
                continue;
            }
            let path = if kind == "plan" {
                format!("plans/{}.md", child_id.to_lowercase())
            } else {
                format!("references/{}.md", child_id.to_lowercase())
            };
            let raw = candidate_or_committed(candidate_root, canonical_root, &path)?.ok_or(
                ProjectWorkPublicationError::Adapter("project_work_managed_record_invalid"),
            )?;
            let child = dashboard::decode_child_body(
                records::frontmatter_body_ref(&raw),
                &id,
                &child_id,
                schema,
                collation,
            )
            .map_err(|_| {
                ProjectWorkPublicationError::Adapter("project_work_managed_record_invalid")
            })?;
            children.insert(child_id, child);
        }
        hydrate(&manifest, &children).map_err(ProjectWorkPublicationError::Work)?;
    }
    Ok(())
}

fn candidate_or_committed(
    candidate: &Path,
    committed: &Path,
    path: &str,
) -> Result<Option<String>, ProjectWorkPublicationError> {
    let selected = candidate.join(path);
    let selected = if selected.exists() {
        selected
    } else {
        committed.join(path)
    };
    match fs::read_to_string(selected) {
        Ok(raw) => Ok(Some(raw)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(ProjectWorkPublicationError::Io(
            "project_ledger_record_io_error",
        )),
    }
}
