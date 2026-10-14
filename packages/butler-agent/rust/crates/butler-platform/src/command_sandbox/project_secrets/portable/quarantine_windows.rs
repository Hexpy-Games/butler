//! Post-reap quarantine. Reparse entries can be renamed, never copied through.
use super::windows::{Directory, open_child, reparse};
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

pub(super) fn move_entry(root: &Directory, run: &Directory, relative: &Path) -> io::Result<()> {
    let name = relative
        .file_name()
        .ok_or_else(|| io::Error::other("quarantine entry has no name"))?;
    let parent = relative.parent().unwrap_or(Path::new(""));
    let source = descend(root, parent, false)?.join(name);
    let target = descend(run, parent, true)?.join(name);
    match fs::rename(&source, &target) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(17) => {
            copy(&source, &target, 0)?;
            remove(&source)
        }
        Err(error) => Err(error),
    }
}
fn descend(base: &Directory, relative: &Path, create: bool) -> io::Result<PathBuf> {
    let mut current = base.clone();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(io::Error::other("quarantine path is not relative"));
        };
        if create {
            match crate::secure_fs::create_private_dir(&current.join(name)) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        current = open_child(&current, name)?;
    }
    Ok(current)
}
fn copy(source: &Path, target: &Path, depth: usize) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if reparse(&metadata) || depth > 128 {
        return Err(io::Error::other(
            "cannot quarantine a reparse or over-deep entry across volumes",
        ));
    }
    if metadata.is_dir() {
        crate::secure_fs::create_private_dir(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy(&entry.path(), &target.join(entry.file_name()), depth + 1)?;
        }
    } else if metadata.is_file() {
        let mut from = fs::File::open(source)?;
        let mut to = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        crate::secure_fs::restrict_file(target).transpose()?;
        io::copy(&mut from, &mut to)?;
    } else {
        return Err(io::Error::other(
            "cannot quarantine a special entry across volumes",
        ));
    }
    Ok(())
}
fn remove(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && !reparse(&metadata) {
        for entry in fs::read_dir(path)? {
            remove(&entry?.path())?;
        }
        fs::remove_dir(path)
    } else if metadata.is_dir() {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}
