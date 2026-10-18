//! Every recreated source gets a durable, unique destination before its rename.
use super::journal::{self, Journal, Relocation};
use butler_platform::secure_fs;
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub(super) fn valid(m: &Relocation) -> bool {
    (super::plan::movable(&m.source) || super::logs::valid(&m.source))
        && super::plan::movable(&m.restored)
        && m.source.parent() == m.restored.parent()
        && m.destination.components().count() == 1
        && m.destination
            .to_str()
            .is_some_and(|p| p.strip_prefix(".recreated-").is_some_and(super::valid_id))
}
fn present(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}
fn collision(root: &Path, journal: &mut Journal, relative: &Path) -> io::Result<PathBuf> {
    let trash = journal.trash(root);
    for entry in &journal.relocations {
        if entry.source == relative && !present(&trash.join(&entry.destination))? {
            return Ok(trash.join(&entry.destination));
        }
    }
    let id = uuid::Uuid::new_v4();
    let entry = Relocation {
        source: relative.to_path_buf(),
        destination: PathBuf::from(format!(".recreated-{id}")),
        restored: relative.with_file_name(format!("reset-recovered-{id}")),
    };
    let destination = trash.join(&entry.destination);
    if present(&destination)? || present(&root.join(&entry.restored))? {
        return Err(io::Error::other("Reset unique destination occupied"));
    }
    journal.relocations.push(entry);
    journal.save(root)?;
    Ok(destination)
}
fn rename(from: &Path, to: &Path) -> io::Result<()> {
    let parent = to
        .parent()
        .ok_or_else(|| io::Error::other("Invalid reset path"))?;
    secure_fs::create_private_dir_all(parent)?;
    secure_fs::rename(from, to)?;
    journal::sync(
        from.parent()
            .ok_or_else(|| io::Error::other("Invalid reset path"))?,
    )?;
    journal::sync(parent)
}

pub(super) fn move_all(root: &Path, journal: &mut Journal) -> io::Result<()> {
    let trash = journal.trash(root);
    match fs::symlink_metadata(&trash) {
        Ok(m) if !m.is_dir() || m.file_type().is_symlink() => {
            return Err(io::Error::other("Invalid reset trash"));
        }
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => secure_fs::create_private_dir(&trash)?,
        Err(e) => return Err(e),
    }
    journal::sync(root)?;
    for relative in journal.moves.clone() {
        let from = root.join(&relative);
        if super::logs::kept(&relative) || !present(&from)? {
            continue;
        }
        let original = trash.join(&relative);
        let to = if present(&original)? {
            collision(root, journal, &relative)?
        } else {
            original
        };
        rename(&from, &to)?;
        secure_fs::fault_checkpoint("data_reset.move")?;
        secure_fs::abort_point("data_reset.move");
        secure_fs::hold_point("data_reset.move", || false)?;
    }
    Ok(())
}

pub(super) fn rollback(root: &Path, journal: &mut Journal) -> io::Result<()> {
    let trash = journal.trash(root);
    for relative in journal.moves.clone().into_iter().rev() {
        let from = trash.join(&relative);
        if super::logs::kept(&relative) || !present(&from)? {
            continue;
        }
        let to = root.join(&relative);
        if present(&to)? {
            let backup = collision(root, journal, &relative)?;
            rename(&to, &backup)?;
        }
        rename(&from, &to)?;
    }
    // A source recreated during recovery must also survive a later I/O failure.
    // Its unique sibling is journaled up front, making interrupted restoration idempotent.
    for entry in &journal.relocations {
        let from = trash.join(&entry.destination);
        if present(&from)? {
            rename(&from, &root.join(&entry.restored))?;
        }
    }
    Ok(())
}

// Older journals planned logs as a whole directory. Resume those as child
// moves too, so a launcher-recreated logs parent can never be renamed.
pub(super) fn expand_legacy_logs(root: &Path, journal: &mut Journal) -> io::Result<()> {
    if !journal.moves.contains(&PathBuf::from("logs")) {
        return Ok(());
    }
    let old = journal.trash(root).join("logs");
    if present(&old)? {
        let metadata = fs::symlink_metadata(&old)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(io::Error::other("Invalid reset log parent"));
        }
        for entry in fs::read_dir(old)? {
            let relative = PathBuf::from("logs").join(entry?.file_name());
            if super::plan::movable(&relative) && !journal.moves.contains(&relative) {
                journal.moves.push(relative);
            }
        }
    }
    journal.moves.retain(|p| p != Path::new("logs"));
    journal.save(root)
}
