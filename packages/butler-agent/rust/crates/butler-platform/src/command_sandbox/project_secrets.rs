//! Portable entry points for project secret discovery and cleanup.
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "linux", windows))]
#[path = "project_secrets/portable/mod.rs"]
pub(in crate::command_sandbox) mod portable;

/// Pre-run protected names and a conservative realtime change cutoff.
#[derive(Default, Debug)]
pub struct ProjectSecretInventory {
    paths: Vec<PathBuf>,
    #[cfg(target_os = "linux")]
    started: Option<std::time::SystemTime>,
    #[cfg(target_os = "linux")]
    writable: Vec<PathBuf>,
}

impl ProjectSecretInventory {
    /// Supply exactly the external roots granted by the command write policy.
    /// No filesystem work is added to command preparation.
    pub fn with_writable_roots(self, roots: &[&Path]) -> Self {
        #[cfg(target_os = "linux")]
        {
            Self {
                writable: roots.iter().map(|path| path.to_path_buf()).collect(),
                ..self
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = roots;
            self
        }
    }
}

impl std::ops::Deref for ProjectSecretInventory {
    type Target = [PathBuf];
    fn deref(&self) -> &Self::Target {
        &self.paths
    }
}

/// Capture the realtime cutoff before the existing metadata-only discovery.
/// One second covers coarse filesystem ctime granularity as well as Linux's
/// cached clock tick. A link close to launch is conservatively judged changed.
/// User space cannot restore ctime after creation, rename or inode reuse.
pub fn discover_project_secret_inventory(root: &Path) -> std::io::Result<ProjectSecretInventory> {
    #[cfg(target_os = "linux")]
    let started = std::time::SystemTime::now().checked_sub(std::time::Duration::from_secs(1));
    Ok(ProjectSecretInventory {
        paths: discover_project_secrets(root)?,
        #[cfg(target_os = "linux")]
        started,
        #[cfg(target_os = "linux")]
        writable: Vec::new(),
    })
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

/// Quarantines new secret names and links to canonical secret targets.
/// Call only after the contained process tree has been reaped.
pub fn sweep_new_secrets(
    root: &Path,
    since: &ProjectSecretInventory,
    data: &Path,
) -> std::io::Result<Vec<PathBuf>> {
    sweep_new_secrets_with_environment(root, since, data, &std::env::vars().collect())
}

/// Sweeps using the same host environment as the command's credential policy.
/// Call only after reaping descendants, from a blocking worker.
pub fn sweep_new_secrets_with_environment(
    root: &Path,
    since: &ProjectSecretInventory,
    data: &Path,
    environment: &std::collections::HashMap<String, String>,
) -> std::io::Result<Vec<PathBuf>> {
    #[cfg(target_os = "linux")]
    {
        let result = portable::sweep_new_secrets(root, since, data, environment);
        let cleaned = super::linux::cleanup_generated(root, data);
        result.and_then(|paths| cleaned.map(|()| paths))
    }
    #[cfg(windows)]
    {
        let _ = environment;
        super::windows::mxc::ledger::sweep(root, since, data)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (root, since, data, environment);
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
