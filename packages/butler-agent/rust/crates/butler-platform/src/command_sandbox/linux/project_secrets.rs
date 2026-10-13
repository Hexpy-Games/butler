//! Metadata-only project discovery. Never follow symlinks or enter secret dirs.
mod quarantine;

use std::os::unix::fs::PermissionsExt;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Finds protected entries before installing a project-write policy. A bounded
/// walk fails closed rather than granting an incompletely inspected hierarchy.
pub(in crate::command_sandbox) fn discover_project_secrets(
    root: &Path,
) -> std::io::Result<Vec<PathBuf>> {
    walk(root, true)
}

/// Moves secret names absent from the pre-run inventory into a private
/// data-folder quarantine. Filesystem timestamps may precede wall-clock launch
/// time by a clock tick, so the inventory is the authority for new names.
/// Traversal inspects metadata only; cross-mount moves copy quarantined entries.
pub(in crate::command_sandbox) fn sweep_new_secrets(
    root: &Path,
    since: &[PathBuf],
    data: &Path,
) -> std::io::Result<Vec<PathBuf>> {
    let existing: HashSet<_> = since.iter().cloned().collect();
    let secrets: Vec<_> = walk(root, false)?
        .into_iter()
        .filter(|path| !existing.contains(path))
        .collect();
    if secrets.is_empty() {
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
    for path in &secrets {
        let relative = path.strip_prefix(root).map_err(std::io::Error::other)?;
        let target = run.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        quarantine::move_entry(path, &target)?;
    }
    Ok(secrets)
}

fn walk(root: &Path, bounded: bool) -> std::io::Result<Vec<PathBuf>> {
    const MAX_ENTRIES: usize = 200_000;
    const MAX_DEPTH: usize = 128;
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut secrets = Vec::new();
    let mut visited = 0;
    while let Some((dir, depth)) = pending.pop() {
        if bounded && depth > MAX_DEPTH {
            return Err(std::io::Error::other(
                "project secret discovery depth exceeded",
            ));
        }
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            visited += 1;
            if bounded && visited > MAX_ENTRIES {
                return Err(std::io::Error::other(
                    "project secret discovery entry limit exceeded",
                ));
            }
            let path = entry.path();
            if super::super::secret_name(&entry.file_name().to_string_lossy()) {
                secrets.push(path);
                // Existing protected directories are excluded, not scanned.
            } else if entry.file_type()?.is_dir() {
                pending.push((path, depth + 1));
            }
        }
    }
    secrets.sort();
    Ok(secrets)
}
