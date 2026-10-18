//! Best-effort deletion runs off Tokio; the applied journal retains pending work.
use super::journal::{self, Journal, Phase};
use butler_platform::{
    secrets::{SecretKey, SecretStore},
    secure_fs,
};
use std::{fs, io, path::Path};

pub(crate) fn clean(root: &Path, mut journal: Journal) -> io::Result<()> {
    secure_fs::remove_tree(&journal.trash(root))?;
    journal::sync(root)?;
    for path in &journal.project_hot_caches {
        remove_hot_cache(path)?;
    }
    journal.project_hot_caches.clear();
    if !journal.secret_keys.is_empty() {
        let store = SecretStore::system().map_err(io::Error::other)?;
        journal.secret_keys.retain(|id| {
            SecretKey::new(&id.service, &id.account).map_or(true, |key| store.delete(&key).is_err())
        });
        journal.save(root)?;
        if !journal.secret_keys.is_empty() {
            return Ok(());
        }
    }
    journal.phase = Phase::Cleaned;
    journal.save(root)?;
    journal::remove(root)
}
fn remove_hot_cache(path: &Path) -> io::Result<()> {
    if path.file_name().is_none_or(|p| p != "hot-cache.md") {
        return Err(io::Error::other("Invalid hot cache"));
    }
    let Some(parent) = path
        .parent()
        .filter(|p| p.file_name().is_some_and(|v| v == ".butler"))
    else {
        return Err(io::Error::other("Invalid hot cache parent"));
    };
    let Some(project) = parent.parent() else {
        return Err(io::Error::other("Invalid project"));
    };
    // A replaced/symlinked registered folder is no longer the snapshot's target.
    if secure_fs::canonicalize(project).is_ok_and(|p| p != project) {
        return Ok(());
    }
    for component in [parent, path] {
        match fs::symlink_metadata(component) {
            Ok(m) if m.file_type().is_symlink() => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
            _ => {}
        }
    }
    match fs::remove_file(path) {
        Ok(()) => journal::sync(parent),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
