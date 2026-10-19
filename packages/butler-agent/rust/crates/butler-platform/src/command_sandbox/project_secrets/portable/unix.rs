//! Directory traversal relative to opened parents. No step follows a symlink,
//! so a component swapped during cleanup cannot redirect it out of the project.
use std::ffi::{OsStr, OsString};
use std::io;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

pub(super) type Directory = OwnedFd;

use rustix::fs::{AtFlags, CWD, Dir, FileType, Mode, OFlags, openat, statat};

/// Opens the walk root itself; aliases in the root path were admitted already.
pub(in crate::command_sandbox) fn open_root(root: &Path) -> io::Result<OwnedFd> {
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC;
    Ok(openat(CWD, root, flags, Mode::empty())?)
}

/// Opens the directory `name` directly below `parent`, never through a symlink.
pub(in crate::command_sandbox) fn open_child(
    parent: impl AsFd,
    name: &OsStr,
) -> io::Result<OwnedFd> {
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    Ok(openat(parent, name, flags, Mode::empty())?)
}

/// The entry type of `name` itself, not of a symlink target.
pub(super) fn kind(parent: impl AsFd, name: &OsStr) -> io::Result<FileType> {
    let stat = statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)?;
    Ok(FileType::from_raw_mode(stat.st_mode))
}

/// Names and directory flags of one directory, read before any is changed.
pub(in crate::command_sandbox) fn entries(dir: &OwnedFd) -> io::Result<Vec<(OsString, bool)>> {
    read_entries(dir, |name, kind| (name, kind == FileType::Directory))
}

/// Only the post-run walk stats links. Launch discovery uses directory-entry
/// types and adds no per-link syscalls. ctime uses the kernel realtime clock.
pub(super) fn entries_with_links(
    dir: &OwnedFd,
    started: Option<super::tree::LinkTime>,
) -> io::Result<Vec<super::tree::Entry>> {
    read_entries(dir, |name, kind| {
        let changed = if kind == FileType::Symlink {
            let stat = statat(dir, name.as_os_str(), AtFlags::SYMLINK_NOFOLLOW)?;
            let ctime = std::time::UNIX_EPOCH
                + std::time::Duration::new(
                    stat.st_ctime.try_into().map_err(io::Error::other)?,
                    stat.st_ctime_nsec.try_into().map_err(io::Error::other)?,
                );
            started
                .is_none_or(|started| ctime >= started)
                .then_some(ctime)
        } else {
            None
        };
        Ok::<_, io::Error>((name, kind == FileType::Directory, changed))
    })?
    .into_iter()
    .collect()
}

fn read_entries<T>(dir: &OwnedFd, project: impl Fn(OsString, FileType) -> T) -> io::Result<Vec<T>> {
    let mut entries = Vec::new();
    for entry in Dir::read_from(dir)? {
        let entry = entry?;
        let name = OsStr::from_bytes(entry.file_name().to_bytes());
        if name == "." || name == ".." {
            continue;
        }
        let kind = match entry.file_type() {
            FileType::Unknown => kind(dir, name)?,
            kind => kind,
        };
        entries.push(project(name.to_os_string(), kind));
    }
    Ok(entries)
}
