//! Canonical project hot-cache paths for continuity recovery.

use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::cognition::{CognitionError, CognitionResult};

pub(super) fn hot_cache_path(workspace: &Path) -> CognitionResult<PathBuf> {
    if !workspace.is_absolute() {
        return Err(error("continuity_project_workspace_unresolved"));
    }
    let canonical = fs::canonicalize(workspace)
        .map_err(|_| error("continuity_project_workspace_unresolved"))?;
    if !canonical.is_dir() {
        return Err(error("continuity_project_workspace_unresolved"));
    }
    let parent = canonical.join(".butler");
    match fs::canonicalize(&parent) {
        Ok(resolved_parent)
            if !resolved_parent.starts_with(&canonical) || !resolved_parent.is_dir() =>
        {
            return Err(error("continuity_recovery_project_binding_changed"));
        }
        Ok(_) => {}
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(error("continuity_recovery_project_binding_changed")),
    }
    let cache = parent.join("hot-cache.md");
    match fs::symlink_metadata(&cache) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(error("continuity_recovery_project_binding_changed"));
        }
        Ok(_) => {
            let resolved = fs::canonicalize(&cache)
                .map_err(|_| error("continuity_recovery_project_binding_changed"))?;
            if !resolved.starts_with(&canonical) || resolved == canonical {
                return Err(error("continuity_recovery_project_binding_changed"));
            }
        }
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(error("continuity_recovery_project_binding_changed")),
    }
    Ok(cache)
}

pub(super) fn validate_hot_cache_path(cache: &Path, workspace: &Path) -> CognitionResult<()> {
    let expected = hot_cache_path(workspace)?;
    if cache != expected {
        return Err(error("continuity_recovery_project_binding_changed"));
    }
    if let Some(parent) = cache.parent()
        && let Ok(canonical_parent) = fs::canonicalize(parent)
    {
        let canonical_workspace = fs::canonicalize(workspace)
            .map_err(|_| error("continuity_project_workspace_unresolved"))?;
        if !canonical_parent.starts_with(canonical_workspace) {
            return Err(error("continuity_recovery_project_binding_changed"));
        }
    }
    Ok(())
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
