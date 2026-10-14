//! Metadata-only project discovery. Never follow symlinks or enter secret dirs.
#[cfg(unix)]
#[path = "quarantine_unix.rs"]
mod quarantine;
#[cfg(windows)]
#[path = "quarantine_windows.rs"]
mod quarantine;
mod tree;
#[cfg(unix)]
mod unix;
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
pub(super) fn sweep_new_secrets(
    root: &Path,
    since: &[PathBuf],
    data: &Path,
) -> std::io::Result<Vec<PathBuf>> {
    let existing: HashSet<_> = since.iter().cloned().collect();
    let secrets: Vec<_> = tree::walk(root, false)?
        .into_iter()
        .map(|relative| root.join(relative))
        .filter(|path| !existing.contains(path))
        .collect();
    if secrets.is_empty() {
        return Ok(secrets);
    }
    let quarantine = data.join("sandbox-quarantine");
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
