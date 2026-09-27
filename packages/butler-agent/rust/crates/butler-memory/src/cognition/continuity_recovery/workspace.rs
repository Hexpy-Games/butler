//! Canonical project hot-cache paths for continuity recovery.

use crate::cognition::CognitionCode;
use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::cognition::{CognitionError, CognitionResult};

pub(super) fn hot_cache_path(workspace: &Path) -> CognitionResult<PathBuf> {
    if !workspace.is_absolute() {
        return Err(error(CognitionCode::ContinuityProjectWorkspaceUnresolved));
    }
    let canonical = fs::canonicalize(workspace).map_err(|source| {
        error(CognitionCode::ContinuityProjectWorkspaceUnresolved).with_source(source)
    })?;
    if !canonical.is_dir() {
        return Err(error(CognitionCode::ContinuityProjectWorkspaceUnresolved));
    }
    let parent = canonical.join(".butler");
    match fs::canonicalize(&parent) {
        Ok(resolved_parent)
            if !resolved_parent.starts_with(&canonical) || !resolved_parent.is_dir() =>
        {
            return Err(error(
                CognitionCode::ContinuityRecoveryProjectBindingChanged,
            ));
        }
        Ok(_) => {}
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            return Err(error(
                CognitionCode::ContinuityRecoveryProjectBindingChanged,
            ));
        }
    }
    let cache = parent.join("hot-cache.md");
    match fs::symlink_metadata(&cache) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(error(
                CognitionCode::ContinuityRecoveryProjectBindingChanged,
            ));
        }
        Ok(_) => {
            let resolved = fs::canonicalize(&cache).map_err(|source| {
                error(CognitionCode::ContinuityRecoveryProjectBindingChanged).with_source(source)
            })?;
            if !resolved.starts_with(&canonical) || resolved == canonical {
                return Err(error(
                    CognitionCode::ContinuityRecoveryProjectBindingChanged,
                ));
            }
        }
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            return Err(error(
                CognitionCode::ContinuityRecoveryProjectBindingChanged,
            ));
        }
    }
    Ok(cache)
}

pub(super) fn validate_hot_cache_path(cache: &Path, workspace: &Path) -> CognitionResult<()> {
    let expected = hot_cache_path(workspace)?;
    if cache != expected {
        return Err(error(
            CognitionCode::ContinuityRecoveryProjectBindingChanged,
        ));
    }
    if let Some(parent) = cache.parent()
        && let Ok(canonical_parent) = fs::canonicalize(parent)
    {
        let canonical_workspace = fs::canonicalize(workspace).map_err(|source| {
            error(CognitionCode::ContinuityProjectWorkspaceUnresolved).with_source(source)
        })?;
        if !canonical_parent.starts_with(canonical_workspace) {
            return Err(error(
                CognitionCode::ContinuityRecoveryProjectBindingChanged,
            ));
        }
    }
    Ok(())
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
