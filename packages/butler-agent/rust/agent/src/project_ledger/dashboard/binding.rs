use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::ProjectLedgerBinding;
use crate::project_ledger::ProjectLedgerReadError;

pub(super) fn resolve(
    data_root: &Path,
    binding: &ProjectLedgerBinding,
) -> Result<PathBuf, ProjectLedgerReadError> {
    resolve_ledger_root(data_root, &binding.ledger_project_id)
}

pub(super) fn resolve_ledger_root(
    data_root: &Path,
    id: &str,
) -> Result<PathBuf, ProjectLedgerReadError> {
    if id.is_empty()
        || id.len() > 120
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(invalid_identity());
    }
    let requested = data_root.join("project-ledger/projects").join(id);
    reject_symlink(&requested)?;
    let root = fs::canonicalize(&requested).map_err(|_| unavailable())?;
    for relative in ["project.json", "index", "index/project.json"] {
        reject_symlink(&root.join(relative))?;
    }
    let raw = fs::read_to_string(root.join("project.json")).map_err(|_| unavailable())?;
    let project: Value = serde_json::from_str(&raw).map_err(|_| invalid_identity())?;
    if project.get("id").and_then(Value::as_str) != Some(id) {
        return Err(ProjectLedgerReadError::Resolution(
            "dashboard_ledger_identity_mismatch",
        ));
    }
    Ok(root)
}

fn reject_symlink(path: &Path) -> Result<(), ProjectLedgerReadError> {
    match fs::symlink_metadata(path) {
        Ok(stat) if stat.file_type().is_symlink() => Err(invalid_identity()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(unavailable()),
    }
}

fn invalid_identity() -> ProjectLedgerReadError {
    ProjectLedgerReadError::Resolution("dashboard_ledger_identity_invalid")
}

fn unavailable() -> ProjectLedgerReadError {
    ProjectLedgerReadError::Resolution("dashboard_ledger_unavailable")
}
