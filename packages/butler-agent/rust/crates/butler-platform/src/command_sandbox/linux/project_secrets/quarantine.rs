//! Move entries relative to opened parents, never through an alias. A rename
//! is atomic; across project/data mounts the entry is copied, then removed.
use std::ffi::OsStr;
use std::io;
use std::os::fd::OwnedFd;
use std::path::{Component, Path};

use rustix::fs::{AtFlags, FileType, Mode, OFlags, mkdirat, openat, readlinkat, symlinkat};
use rustix::fs::{renameat, unlinkat};

use super::tree::{entries, kind, open_child};

/// Cross-mount copies recurse; a deeper entry fails instead of exhausting fds.
const MAX_COPY_DEPTH: usize = 128;

/// Moves `relative` below `root` to the same relative path below `run`.
pub(super) fn move_entry(root: &OwnedFd, run: &OwnedFd, relative: &Path) -> io::Result<()> {
    let name = relative
        .file_name()
        .ok_or_else(|| io::Error::other("quarantine entry has no name"))?;
    let parent = relative.parent().unwrap_or(Path::new(""));
    let source = descend(root, parent, false)?;
    let target = descend(run, parent, true)?;
    match renameat(&source, name, &target, name) {
        Ok(()) => Ok(()),
        Err(rustix::io::Errno::XDEV) => {
            copy(&source, name, &target, 0)?;
            remove(&source, name)
        }
        Err(error) => Err(error.into()),
    }
}

fn descend(base: &OwnedFd, relative: &Path, create: bool) -> io::Result<OwnedFd> {
    let mut current = base.try_clone()?;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(io::Error::other("quarantine path is not relative"));
        };
        if create {
            match mkdirat(&current, name, Mode::RWXU) {
                Ok(()) | Err(rustix::io::Errno::EXIST) => {}
                Err(error) => return Err(error.into()),
            }
        }
        current = open_child(&current, name)?;
    }
    Ok(current)
}

fn copy(source: &OwnedFd, name: &OsStr, target: &OwnedFd, depth: usize) -> io::Result<()> {
    match kind(source, name)? {
        FileType::Symlink => symlinkat(readlinkat(source, name, Vec::new())?, target, name)?,
        FileType::Directory if depth < MAX_COPY_DEPTH => {
            mkdirat(target, name, Mode::RWXU)?;
            let (from, to) = (open_child(source, name)?, open_child(target, name)?);
            for (child, _) in entries(&from)? {
                copy(&from, &child, &to, depth + 1)?;
            }
        }
        FileType::RegularFile => {
            let read = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
            let write = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC;
            let from = openat(source, name, read, Mode::empty())?;
            let to = openat(target, name, write, Mode::RUSR | Mode::WUSR)?;
            io::copy(&mut std::fs::File::from(from), &mut std::fs::File::from(to))?;
        }
        _ => {
            return Err(io::Error::other(
                "cannot quarantine a special or over-deep entry across mounts",
            ));
        }
    }
    Ok(())
}

// Called only after a complete copy. Symlinks are unlinked, never followed.
fn remove(parent: &OwnedFd, name: &OsStr) -> io::Result<()> {
    if kind(parent, name)? == FileType::Directory {
        let dir = open_child(parent, name)?;
        for (child, _) in entries(&dir)? {
            remove(&dir, &child)?;
        }
        unlinkat(parent, name, AtFlags::REMOVEDIR)?;
    } else {
        unlinkat(parent, name, AtFlags::empty())?;
    }
    Ok(())
}
