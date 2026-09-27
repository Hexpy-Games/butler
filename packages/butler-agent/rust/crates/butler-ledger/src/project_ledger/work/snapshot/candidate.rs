use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde_json::Value;

use butler_core::locale::LocaleCollation;
use butler_turn::btcc::ResolvedProjectWorkScope;

use super::super::super::publication::{
    ProjectLedgerRecordKind, ProjectLedgerRecordUpdate, ProjectWorkPublicationError,
};
use super::super::super::{dashboard, records};
use super::{child_refs, dependencies, hydrate};

/// Every managed Work the updates touch still hydrates from the candidate,
/// reading records the candidate does not rewrite from the canonical root.
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
    let reader = CandidateReader {
        candidate_root,
        canonical_root,
        collation,
    };
    for id in ids {
        reader.validate_work(scope, &id)?;
    }
    Ok(())
}

fn managed_invalid() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::adapter("project_work_managed_record_invalid")
}

struct CandidateReader<'a> {
    candidate_root: &'a Path,
    canonical_root: &'a Path,
    collation: &'a LocaleCollation,
}

impl CandidateReader<'_> {
    fn read(&self, path: &str) -> Result<String, ProjectWorkPublicationError> {
        candidate_or_committed(self.candidate_root, self.canonical_root, path)?
            .ok_or_else(managed_invalid)
    }

    /// The Work's manifest and children decode and hydrate into a view.
    fn validate_work(
        &self,
        scope: &ResolvedProjectWorkScope,
        id: &str,
    ) -> Result<(), ProjectWorkPublicationError> {
        let raw = self.read(&format!("work/{id}/work.md"))?;
        let manifest = dashboard::decode_manifest_body(
            records::frontmatter_body_ref(&raw),
            id,
            &scope.app_project_id,
            &scope.ledger_project_id,
            self.collation,
        )
        .map_err(|source| managed_invalid().with_source(source))?;
        let refs = child_refs(&manifest).map_err(|source| managed_invalid().with_source(source))?;
        let mut children = HashMap::with_capacity(refs.len());
        for (child_id, kind, schema) in refs {
            let child = self.child(id, &child_id, kind, schema)?;
            children.insert(child_id, child);
        }
        let dependencies =
            dependencies::refs(&manifest, &children).map_err(ProjectWorkPublicationError::Work)?;
        for (child_id, kind, schema) in dependencies {
            if let Some(existing) = children.get(&child_id) {
                if existing.get("schema").and_then(Value::as_str) != Some(schema) {
                    return Err(managed_invalid());
                }
                continue;
            }
            let child = self.child(id, &child_id, kind, schema)?;
            children.insert(child_id, child);
        }
        hydrate(&manifest, &children).map_err(ProjectWorkPublicationError::Work)?;
        Ok(())
    }

    fn child(
        &self,
        work_id: &str,
        child_id: &str,
        kind: &str,
        schema: &str,
    ) -> Result<Value, ProjectWorkPublicationError> {
        let directory = if kind == "plan" {
            "plans"
        } else {
            "references"
        };
        let raw = self.read(&format!("{directory}/{}.md", child_id.to_lowercase()))?;
        dashboard::decode_child_body(
            records::frontmatter_body_ref(&raw),
            work_id,
            child_id,
            schema,
            self.collation,
        )
        .map_err(|source| managed_invalid().with_source(source))
    }
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
        Err(_) => Err(ProjectWorkPublicationError::io(
            "project_ledger_record_io_error",
        )),
    }
}
