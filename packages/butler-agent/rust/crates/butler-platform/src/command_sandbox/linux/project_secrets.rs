//! Metadata-only project discovery. Never follow symlinks or enter secret dirs.
mod links;
mod quarantine;
mod tree;

use std::os::unix::fs::PermissionsExt;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Finds protected entries before installing a project-write policy. A bounded
/// walk fails closed rather than granting an incompletely inspected hierarchy.
pub(in crate::command_sandbox) fn discover_project_secrets(
    root: &Path,
) -> std::io::Result<Vec<PathBuf>> {
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
pub(in crate::command_sandbox) fn sweep_new_secrets(
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
        super::generated::cleanup(root, data, false)?;
        return Ok(secrets);
    }
    let quarantine = data.join("sandbox-quarantine");
    std::fs::create_dir_all(&quarantine)?;
    std::fs::set_permissions(&quarantine, std::fs::Permissions::from_mode(0o700))?;
    let run = quarantine.join(format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(std::io::Error::other)?
            .as_nanos()
    ));
    std::fs::create_dir(&run)?;
    std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700))?;
    let (source, target) = (tree::open_root(root)?, tree::open_root(&run)?);
    let mut failure = None;
    for path in &secrets {
        let relative = path.strip_prefix(root).map_err(std::io::Error::other)?;
        if let Err(error) = quarantine::move_entry(&source, &target, relative) {
            failure.get_or_insert(error);
        }
    }
    if let Err(error) = super::generated::cleanup(root, data, false) {
        failure.get_or_insert(error);
    }
    failure.map_or(Ok(secrets), Err)
}

pub(super) fn validate_links(policy: &super::Policy) -> Result<(), super::Error> {
    links::validate(policy)
}
