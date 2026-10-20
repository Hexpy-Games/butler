//! Portable entry points for project secret discovery and cleanup.
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "linux", windows))]
#[path = "project_secrets/portable/mod.rs"]
pub(in crate::command_sandbox) mod portable;

/// Pre-run names from the existing directory-entry walk. No identity,
/// timestamp, target resolution or credential-tree walk is performed here.
#[derive(Debug)]
#[cfg_attr(not(target_os = "linux"), derive(Default))]
pub struct ProjectEntries {
    protected: Vec<PathBuf>,
    #[cfg(target_os = "linux")]
    started: std::time::SystemTime,
}
impl std::ops::Deref for ProjectEntries {
    type Target = [PathBuf];
    fn deref(&self) -> &Self::Target {
        &self.protected
    }
}
/// Capture protected names and existing links in a single metadata-only pass.
pub fn discover_project_entries(root: &Path) -> std::io::Result<ProjectEntries> {
    #[cfg(target_os = "linux")]
    {
        let started = std::time::SystemTime::now();
        let names = portable::tree::walk(root, true)?;
        Ok(ProjectEntries {
            protected: names.into_iter().map(|path| root.join(path)).collect(),
            started,
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(ProjectEntries {
            protected: discover_project_secrets(root)?,
        })
    }
}

/// Finds existing protected names with a bounded metadata-only walk.
pub fn discover_project_secrets(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    #[cfg(target_os = "linux")]
    return portable::discover_project_secrets(root);
    #[cfg(windows)]
    return super::windows::mxc::ledger::secrets(root);
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
    since: &ProjectEntries,
    data: &Path,
) -> std::io::Result<Vec<PathBuf>> {
    sweep_with_inventory(
        root,
        since,
        data,
        &crate::secure_fs::SecretInventory::cached(data),
    )
}

/// Sweep with the command's host policy, independent of other environments.
pub fn sweep_with_inventory(
    root: &Path,
    since: &ProjectEntries,
    data: &Path,
    inventory: &crate::secure_fs::SecretInventory,
) -> std::io::Result<Vec<PathBuf>> {
    #[cfg(target_os = "linux")]
    {
        let result = portable::sweep_new_secrets(root, since, data, inventory);
        let cleaned = super::linux::cleanup_generated(root, data);
        result.and_then(|paths| cleaned.map(|()| paths))
    }
    #[cfg(windows)]
    {
        let _ = inventory;
        super::windows::mxc::ledger::sweep(root, since, data)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (root, since, data, inventory);
        Ok(Vec::new())
    }
}

/// Begin project inventory preparation before the first command. Best effort:
/// admission still checks readiness and fails closed if preparation failed.
/// Call from a blocking worker, because watcher setup opens directory handles.
pub fn prewarm_project(root: &Path) {
    #[cfg(windows)]
    let _ = super::windows::mxc::ledger::prewarm(root);
    #[cfg(not(windows))]
    let _ = root;
}

#[cfg(target_os = "linux")]
impl Default for ProjectEntries {
    fn default() -> Self {
        Self {
            protected: Vec::new(),
            #[cfg(target_os = "linux")]
            started: std::time::SystemTime::now(),
        }
    }
}
