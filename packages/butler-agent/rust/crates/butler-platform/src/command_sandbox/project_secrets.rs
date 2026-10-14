//! Portable entry points for project secret discovery and cleanup.
use std::path::{Path, PathBuf};

/// Finds existing protected names with a bounded metadata-only walk.
pub fn discover_project_secrets(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    #[cfg(target_os = "linux")]
    return super::linux::discover_project_secrets(root);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = root;
        Ok(Vec::new())
    }
}

/// Quarantines secret names absent from the pre-run discovery inventory.
/// The inventory avoids relying on filesystem timestamp precision.
pub fn sweep_new_secrets(
    root: &Path,
    since: &[PathBuf],
    data: &Path,
) -> std::io::Result<Vec<PathBuf>> {
    #[cfg(target_os = "linux")]
    return super::linux::sweep_new_secrets(root, since, data);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (root, since, data);
        Ok(Vec::new())
    }
}
