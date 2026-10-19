//! Metadata-only project discovery. Never follow symlinks or enter secret dirs.
#[cfg(unix)]
#[path = "quarantine_unix.rs"]
mod quarantine;
#[cfg(windows)]
#[path = "quarantine_windows.rs"]
mod quarantine;
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

/// Moves secret names absent from the pre-run inventory into a private
/// data-folder quarantine. Filesystem timestamps may precede wall-clock launch
/// time by a clock tick, so the inventory is the authority for new names.
/// Directories the walk cannot inspect are quarantined whole. One failed move
/// never leaves later entries in place: all are attempted, then it reports.
#[cfg(unix)]
pub(super) fn sweep_new_secrets(
    root: &Path,
    since: &super::ProjectEntries,
    data: &Path,
) -> std::io::Result<Vec<PathBuf>> {
    let (names, links) = tree::entries(root, false)?;
    let mut found: Vec<_> = names.into_iter().map(|path| root.join(path)).collect();
    let inventory = crate::secure_fs::SecretInventory::cached(data);
    let mut targets: Vec<_> = inventory
        .paths()
        .iter()
        .chain(found.iter())
        .filter_map(|path| crate::secure_fs::canonicalize(path).ok())
        .collect();
    targets.extend(inventory.paths().iter().cloned());
    let existing: HashSet<_> = since.links.iter().collect();
    for path in links.into_iter().map(|path| root.join(path)) {
        if existing.contains(&path) {
            continue;
        }
        let target = crate::command_sandbox::linux::complement::resolved_path(&path)
            .or_else(|_| crate::command_sandbox::linux::unresolved::target(&path));
        if target.is_ok_and(|target| {
            targets
                .iter()
                .any(|root| crate::secure_fs::path_is_within(&target, root))
        }) {
            found.push(path);
        }
    }
    found.sort();
    found.dedup();
    quarantine_new(root, since, data, found)
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
