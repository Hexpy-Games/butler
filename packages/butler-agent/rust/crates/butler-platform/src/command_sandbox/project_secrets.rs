//! Portable entry points for project secret discovery and cleanup.
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "linux", windows))]
#[path = "project_secrets/portable/mod.rs"]
pub(in crate::command_sandbox) mod portable;

/// Pre-run protected names and no-follow link identities from one walk.
#[derive(Default, Debug)]
pub struct ProjectSecretInventory {
    paths: Vec<PathBuf>,
    #[cfg(target_os = "linux")]
    links: std::collections::HashMap<PathBuf, portable::tree::LinkIdentity>,
    #[cfg(target_os = "linux")]
    link_targets: std::collections::HashMap<PathBuf, PathBuf>,
}

impl std::ops::Deref for ProjectSecretInventory {
    type Target = [PathBuf];
    fn deref(&self) -> &Self::Target {
        &self.paths
    }
}

/// Captures link identities in one no-follow walk. Protected aliases are
/// resolved before execution so the sweep can reuse untouched targets.
pub fn discover_project_secret_inventory(root: &Path) -> std::io::Result<ProjectSecretInventory> {
    #[cfg(target_os = "linux")]
    {
        let (paths, links) = portable::tree::inventory(root)?;
        let links: std::collections::HashMap<_, _> = links.into_iter().collect();
        let link_targets = paths
            .iter()
            .filter(|path| links.contains_key(*path))
            .map(|path| {
                let absolute = root.join(path);
                let target = absolute
                    .canonicalize()
                    .or_else(|error| {
                        if error.kind() == std::io::ErrorKind::NotFound {
                            super::linux::unresolved::target(&absolute)
                        } else {
                            Err(error)
                        }
                    })
                    .unwrap_or(absolute);
                (path.clone(), target)
            })
            .collect();
        Ok(ProjectSecretInventory {
            link_targets,
            paths: paths.into_iter().map(|path| root.join(path)).collect(),
            links,
        })
    }
    #[cfg(not(target_os = "linux"))]
    Ok(ProjectSecretInventory {
        paths: discover_project_secrets(root)?,
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
