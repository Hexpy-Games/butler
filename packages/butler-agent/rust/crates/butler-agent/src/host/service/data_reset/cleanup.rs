//! Best-effort deletion runs off Tokio; the applied journal retains pending work.
use super::journal::{self, Journal, Phase, TRASH_PREFIX};
use butler_platform::{
    secrets::{SecretKey, SecretStore},
    secure_fs,
};
use std::{fs, io, path::Path};

pub(crate) fn clean(root: &Path, mut journal: Journal) -> io::Result<()> {
    let _change = journal::CHANGES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !journal::load(root)?.is_some_and(|current| {
        current.id == journal.id
            && current.new_generation == journal.new_generation
            && matches!(current.phase, Phase::Applied)
    }) {
        return Ok(());
    }
    clean_secrets(&mut journal);
    journal
        .project_hot_caches
        .retain(|path| remove_hot_cache(path).is_err());
    journal
        .kept_logs
        .retain(|path| match secure_fs::truncate_file_beneath(root, path) {
            Ok(()) => false,
            Err(e) => e.kind() != io::ErrorKind::NotFound,
        });
    let trash = std::path::PathBuf::from(format!("{TRASH_PREFIX}{}", journal.id));
    if !journal.pending_trash.contains(&trash) {
        journal.pending_trash.push(trash);
    }
    journal
        .pending_trash
        .retain(|path| remove_trash(&root.join(path)).is_err());
    journal.save(root)?;
    if journal.secret_keys.is_empty()
        && journal.project_hot_caches.is_empty()
        && journal.pending_trash.is_empty()
        && journal.kept_logs.is_empty()
    {
        journal.phase = Phase::Cleaned;
        journal.save(root)?;
        journal::remove(root)?;
    }
    Ok(())
}
fn clean_secrets(journal: &mut Journal) {
    if journal.secret_keys.is_empty() {
        return;
    }
    if let Ok(store) = SecretStore::system() {
        journal.secret_keys.retain(|id| {
            SecretKey::new(&id.service, &id.account).map_or(true, |key| store.delete(&key).is_err())
        });
    }
}
fn remove_trash(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => secure_fs::unlink(path),
        Ok(_) => secure_fs::remove_tree(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }?;
    if let Some(parent) = path.parent() {
        journal::sync(parent)?;
    }
    Ok(())
}

// Only inspect top-level entries; no journal ever authorizes following a link.
pub(crate) fn orphans(root: &Path) -> io::Result<()> {
    let _change = journal::CHANGES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let live = journal::load(root)?;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = std::path::PathBuf::from(entry.file_name());
        if !name.to_string_lossy().starts_with(TRASH_PREFIX) {
            continue;
        }
        let kind = entry.file_type()?;
        if !kind.is_dir() && !kind.is_symlink() {
            continue;
        }
        if live
            .as_ref()
            .is_some_and(|j| j.trash(root) == entry.path() || j.pending_trash.contains(&name))
        {
            continue;
        }
        if let Err(error) = remove_trash(&entry.path()) {
            butler_core::diagnostic!("[full-reset] orphan trash cleanup pending: {error}");
        }
    }
    journal::sync(root)
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
