use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::super::contracts::ProjectWorkPublicationError;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Claim {
    schema: String,
    claim_id: String,
    publication_id: String,
    canonical_root: String,
    base_sha256: String,
    journal_path: String,
}

pub(in crate::project_ledger::publication) fn path(root: &Path) -> PathBuf {
    root.parent()
        .unwrap_or(root)
        .join(".project-ledger-locks")
        .join(format!(
            "{}.lock",
            root.file_name().unwrap_or_default().to_string_lossy()
        ))
}

pub(in crate::project_ledger::publication) fn acquire(
    root: &Path,
    publication_id: &str,
    base_sha256: &str,
    journal_path: &Path,
) -> Result<(), ProjectWorkPublicationError> {
    let claim_path = path(root);
    if claim_path.exists() {
        return assert_owned(&claim_path, root, publication_id, base_sha256);
    }
    let parent = claim_path.parent().ok_or_else(io)?;
    fs::create_dir_all(parent).map_err(|_| io())?;
    let candidate = parent.join(format!(
        "{}.candidate-{}",
        claim_path.file_name().unwrap_or_default().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let claim = Claim {
        schema: "project-ledger.publication-claim.v1".into(),
        claim_id: publication_id.into(),
        publication_id: publication_id.into(),
        canonical_root: root.to_string_lossy().into_owned(),
        base_sha256: base_sha256.into(),
        journal_path: journal_path.to_string_lossy().into_owned(),
    };
    let mut bytes = serde_json::to_vec_pretty(&claim).map_err(|_| io())?;
    bytes.push(b'\n');
    fs::write(&candidate, bytes).map_err(|_| io())?;
    let linked = fs::hard_link(&candidate, &claim_path);
    let _ = fs::remove_file(candidate);
    match linked {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            assert_owned(&claim_path, root, publication_id, base_sha256)
        }
        Err(_) => Err(io()),
    }
}

pub(in crate::project_ledger::publication) fn assert_owned(
    path: &Path,
    root: &Path,
    publication_id: &str,
    base_sha256: &str,
) -> Result<(), ProjectWorkPublicationError> {
    let bytes = fs::read(path).map_err(|_| ProjectWorkPublicationError::Uncertain)?;
    let claim: Claim =
        serde_json::from_slice(&bytes).map_err(|_| ProjectWorkPublicationError::Uncertain)?;
    if claim.schema != "project-ledger.publication-claim.v1"
        || claim.claim_id != publication_id
        || claim.publication_id != publication_id
        || claim.canonical_root != root.to_string_lossy()
        || claim.base_sha256 != base_sha256
    {
        return Err(ProjectWorkPublicationError::Uncertain);
    }
    Ok(())
}

pub(in crate::project_ledger::publication) fn release_if_owned(
    path: &Path,
    root: &Path,
    publication_id: &str,
    base_sha256: &str,
) -> Result<(), ProjectWorkPublicationError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(io()),
    };
    let claim: Claim =
        serde_json::from_slice(&bytes).map_err(|_| ProjectWorkPublicationError::Uncertain)?;
    if claim.schema != "project-ledger.publication-claim.v1"
        || claim.publication_id != publication_id
        || claim.canonical_root != root.to_string_lossy()
        || claim.base_sha256 != base_sha256
    {
        return Ok(());
    }
    fs::remove_file(path).map_err(|_| io())
}

fn io() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::Io("project_ledger_claim_io_error")
}
