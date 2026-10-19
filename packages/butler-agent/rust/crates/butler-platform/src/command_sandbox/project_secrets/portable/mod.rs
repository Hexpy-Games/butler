//! Metadata-only discovery; post-run link resolution never reads target contents.
#[cfg(unix)]
mod identity;
#[cfg(unix)]
#[path = "quarantine_unix.rs"]
mod quarantine;
#[cfg(windows)]
#[path = "quarantine_windows.rs"]
mod quarantine;
#[cfg(unix)]
mod targets;
pub(in crate::command_sandbox) mod tree;
#[cfg(unix)]
pub(in crate::command_sandbox) mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
use unix as native;
#[cfg(windows)]
use windows as native;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Finds protected entries before installing a project-write policy. A bounded
/// walk fails closed rather than granting an incompletely inspected hierarchy.
#[cfg(unix)]
pub(super) fn discover_project_secrets(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    Ok(tree::walk(root, true)?
        .into_iter()
        .map(|relative| root.join(relative))
        .collect())
}

/// Moves new secret names and unsafe ordinary-named links into a private
/// data-folder quarantine. The inventory identifies existing protected names;
/// a conservative ctime cutoff identifies new or changed links.
/// Directories the walk cannot inspect are quarantined whole. One failed move
/// never leaves later entries in place: all are attempted, then it reports.
#[cfg(unix)]
pub(super) fn sweep_new_secrets(
    root: &Path,
    since: &super::ProjectSecretInventory,
    data: &Path,
    environment: &std::collections::HashMap<String, String>,
) -> std::io::Result<Vec<PathBuf>> {
    let (found, links) = tree::walk_for_sweep(root, since)?;
    let mut found: Vec<_> = found
        .into_iter()
        .map(|relative| root.join(relative))
        .collect();
    // A deliberate user-created old link into private scratch is an accepted
    // residual. Sandboxed links and swapped intermediate links have fresh ctime.
    if links.is_empty() {
        return quarantine_new(root, since, data, found);
    }
    let mut targets = targets::SecretTargets::new(&found, data, environment, root, &since.writable);
    let mut changed_paths = HashSet::new();
    for (relative, _) in links {
        let path = root.join(relative);
        // Resolve only new or changed links after reaping.
        // Missing targets retain their lexical destination and ancestor identity.
        let target = crate::command_sandbox::linux::complement::resolved_path(&path)
            .or_else(|_| crate::command_sandbox::linux::unresolved::target(&path));
        let unsafe_link = targets.writable_indirection(&path, target.as_deref().ok())
            || target.as_ref().is_ok_and(|target| targets.protects(target));
        changed_paths.insert(path.clone());
        if unsafe_link {
            found.push(path);
        }
    }
    found.sort();
    found.dedup();
    let existing: Vec<_> = since
        .iter()
        .filter(|path| !changed_paths.contains(*path))
        .cloned()
        .collect();
    quarantine_new(root, &existing, data, found)
}

pub(in crate::command_sandbox) fn quarantine_new(
    root: &Path,
    since: &[PathBuf],
    data: &Path,
    found: Vec<PathBuf>,
) -> std::io::Result<Vec<PathBuf>> {
    let existing: HashSet<_> = since.iter().cloned().collect();
    let secrets: Vec<_> = found
        .into_iter()
        .filter(|path| !existing.contains(path))
        .collect();
    if secrets.is_empty() {
        return Ok(secrets);
    }
    let quarantine = data.join(crate::data_paths::SANDBOX_QUARANTINE);
    crate::secure_fs::create_private_dir_all(&quarantine)?;
    crate::secure_fs::restrict_directory(&quarantine).transpose()?;
    let run = quarantine.join(format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(std::io::Error::other)?
            .as_nanos()
    ));
    crate::secure_fs::create_private_dir(&run)?;
    let (source, target) = (native::open_root(root)?, native::open_root(&run)?);
    let mut failure = None;
    for path in &secrets {
        let relative = path.strip_prefix(root).map_err(std::io::Error::other)?;
        if let Err(error) = quarantine::move_entry(&source, &target, relative) {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(secrets), Err)
}
