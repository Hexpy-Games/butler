//! Portable entry points for project secret discovery and cleanup.
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "linux", windows))]
#[path = "project_secrets/portable/mod.rs"]
mod portable;

/// Finds existing protected names with a bounded metadata-only walk.
pub fn discover_project_secrets(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    #[cfg(any(target_os = "linux", windows))]
    return portable::discover_project_secrets(root);
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = root;
        Ok(Vec::new())
    }
}

/// Quarantines secret names absent from the pre-run discovery inventory.
/// Call only after the contained process tree has been reaped.
pub fn sweep_new_secrets(
    root: &Path,
    since: &[PathBuf],
    data: &Path,
) -> std::io::Result<Vec<PathBuf>> {
    #[cfg(any(target_os = "linux", windows))]
    return portable::sweep_new_secrets(root, since, data);
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (root, since, data);
        Ok(Vec::new())
    }
}
