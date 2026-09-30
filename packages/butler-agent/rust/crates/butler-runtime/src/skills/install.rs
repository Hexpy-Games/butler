//! Publish complete skill trees, serialized by installed name across processes.

use super::{SkillDefinition, SkillError, archive::copy_tree, catalog};
use butler_platform::secure_fs::{self, ExchangeError};
use std::{fs, io, path::Path};

pub(super) fn replace(
    source: &Path,
    root: &Path,
    name: &str,
) -> Result<Option<SkillDefinition>, SkillError> {
    let locks = root.join(".locks");
    secure_fs::create_private_dir_all(&locks).map_err(SkillError::Io)?;
    let mut options = fs::OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    let _ = secure_fs::owner_only(&mut options);
    let lock = options.open(locks.join(name)).map_err(SkillError::Io)?;
    lock.lock().map_err(SkillError::Io)?;
    let destination = root.join(name);
    let previous = root.join(format!(".previous-{name}"));
    // Windows' journaled two-rename fallback can leave the prior tree here.
    if !destination.exists() && previous.exists() {
        secure_fs::rename(&previous, &destination).map_err(SkillError::Io)?;
    }
    let temporary = root.join(format!(".import-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut definition = catalog::read(&source.join("SKILL.md"))?;
        copy_tree(source, &temporary)?;
        sync_tree(&temporary).map_err(SkillError::Io)?;
        publish(&temporary, &destination, &previous).map_err(SkillError::Io)?;
        if let Some(skill) = &mut definition {
            skill.file_path = destination.join("SKILL.md");
        }
        Ok(definition)
    })();
    // On Unix an exchanged old tree is disposable. On Windows rollback data
    // lives in `previous`, and is retained if restoration could not complete.
    let _ = fs::remove_dir_all(&temporary);
    result
}

/// Unix exchanges complete trees. Without exchange, move the old tree to a
/// stable sibling journal, then install; restore on error and on the next import.
/// That fallback has a brief missing-name window, never a partially copied tree.
fn publish(temporary: &Path, destination: &Path, previous: &Path) -> io::Result<()> {
    if !destination.exists() {
        secure_fs::rename(temporary, destination)?;
        return secure_fs::sync_directory(destination.parent().unwrap_or(Path::new(".")))
            .unwrap_or(Ok(()));
    }
    match secure_fs::exchange_directories(temporary, destination) {
        Ok(()) => {}
        Err(ExchangeError::Unsupported) => {
            if previous.exists() {
                fs::remove_dir_all(previous)?;
            }
            secure_fs::rename(destination, previous)?;
            if let Err(error) = secure_fs::rename(temporary, destination) {
                let _ = secure_fs::rename(previous, destination);
                return Err(error);
            }
            let _ = fs::remove_dir_all(previous);
        }
        Err(error) => return Err(io::Error::other(error)),
    }
    secure_fs::sync_directory(destination.parent().unwrap_or(Path::new("."))).unwrap_or(Ok(()))
}

fn sync_tree(root: &Path) -> io::Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            sync_tree(&entry.path())?;
        } else {
            secure_fs::sync_path(entry.path())?;
        }
    }
    secure_fs::sync_directory(root).unwrap_or(Ok(()))
}
