use std::fs;
use std::path::Path;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::btcc::ResolvedProjectWorkScope;

use super::super::contracts::{
    ProjectWorkPublicationError, ProjectWorkTarget, ProjectWorkTargetState,
};
use super::{record_path, relative};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(in crate::project_ledger::publication) struct ProjectWorkHead {
    pub schema: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_authority: Option<String>,
    pub project_root: String,
    pub source_sha256: String,
    pub source_file_count: usize,
    pub storage_sha256: String,
    pub storage_entry_count: usize,
    pub record_paths: Vec<String>,
}

pub(in crate::project_ledger::publication) fn observe_head(
    root: &Path,
    paths: &[String],
) -> Result<ProjectWorkHead, ProjectWorkPublicationError> {
    let mut paths = paths.to_vec();
    paths.push("project.json".into());
    paths.sort();
    paths.dedup();
    let mut hash = Sha256::new();
    let mut present = 0;
    for relative in &paths {
        let path = record_path(root, relative)?;
        let raw = match fs::read(path) {
            Ok(bytes) => {
                present += 1;
                Some(STANDARD.encode(bytes))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => {
                return Err(ProjectWorkPublicationError::Io(
                    "project_ledger_head_io_error",
                ));
            }
        };
        let entry = serde_json::to_vec(&(relative, raw))
            .map_err(|_| ProjectWorkPublicationError::Adapter("project_ledger_head_invalid"))?;
        hash.update(entry);
    }
    let mut work_directories = Vec::new();
    match fs::read_dir(root.join("work")) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry
                    .map_err(|_| ProjectWorkPublicationError::Io("project_ledger_head_io_error"))?;
                let kind = entry
                    .file_type()
                    .map_err(|_| ProjectWorkPublicationError::Io("project_ledger_head_io_error"))?;
                if kind.is_dir() {
                    work_directories.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            return Err(ProjectWorkPublicationError::Io(
                "project_ledger_head_io_error",
            ));
        }
    }
    work_directories.sort();
    let directory_bytes = serde_json::to_vec(&work_directories)
        .map_err(|_| ProjectWorkPublicationError::Adapter("project_ledger_head_invalid"))?;
    hash.update(directory_bytes);
    let digest = format!("{:x}", hash.finalize());
    Ok(ProjectWorkHead {
        schema: "butler.btcc-project-ledger-head.v1".into(),
        storage_authority: None,
        project_root: root.to_string_lossy().into_owned(),
        source_sha256: digest.clone(),
        source_file_count: present,
        storage_sha256: digest,
        storage_entry_count: present,
        record_paths: paths,
    })
}

pub(in crate::project_ledger::publication) fn observe_core_head(
    root: &Path,
    paths: &[String],
) -> Result<ProjectWorkHead, ProjectWorkPublicationError> {
    let mut head = observe_head(root, paths)?;
    head.schema = "project-ledger.source-head.v1".into();
    head.storage_authority = Some("project-ledger-record-set-v1".into());
    Ok(head)
}

pub(in crate::project_ledger::publication) fn revalidate_target(
    scope: &ResolvedProjectWorkScope,
    target: &ProjectWorkTarget,
) -> Result<(), ProjectWorkPublicationError> {
    let relative = relative(scope, &target.path)?;
    let raw = crate::project_ledger::committed::read_selected(&scope.ledger_root, relative)
        .map_err(|_| ProjectWorkPublicationError::Adapter("project_ledger_exact_read_failed"))?;
    match (&target.state, raw) {
        (ProjectWorkTargetState::Absent, None) => Ok(()),
        (ProjectWorkTargetState::Present, Some(raw))
            if target.raw_record_sha256.as_deref() == Some(sha(raw.as_bytes()).as_str()) =>
        {
            Ok(())
        }
        _ => Err(ProjectWorkPublicationError::Adapter(
            "project_ledger_exact_record_hash_changed",
        )),
    }
}

pub(super) fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
