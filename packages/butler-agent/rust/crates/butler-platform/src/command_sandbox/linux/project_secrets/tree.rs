//! Directory traversal relative to opened parents. No step follows a symlink,
//! so a component swapped during cleanup cannot redirect it out of the project.
use std::ffi::{OsStr, OsString};
use std::io;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use rustix::fs::{AtFlags, CWD, Dir, FileType, Mode, OFlags, openat, statat};

pub(super) const MAX_ENTRIES: usize = 200_000;
pub(super) const MAX_DEPTH: usize = 128;

/// Opens the walk root itself; aliases in the root path were admitted already.
pub(super) fn open_root(root: &Path) -> io::Result<OwnedFd> {
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC;
    Ok(openat(CWD, root, flags, Mode::empty())?)
}

/// Opens the directory `name` directly below `parent`, never through a symlink.
pub(super) fn open_child(parent: impl AsFd, name: &OsStr) -> io::Result<OwnedFd> {
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    Ok(openat(parent, name, flags, Mode::empty())?)
}

/// The entry type of `name` itself, not of a symlink target.
pub(super) fn kind(parent: impl AsFd, name: &OsStr) -> io::Result<FileType> {
    let stat = statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)?;
    Ok(FileType::from_raw_mode(stat.st_mode))
}

/// Names and directory flags of one directory, read before any is changed.
pub(super) fn entries(dir: &OwnedFd) -> io::Result<Vec<(OsString, bool)>> {
    let mut entries = Vec::new();
    for entry in Dir::read_from(dir)? {
        let entry = entry?;
        let name = OsStr::from_bytes(entry.file_name().to_bytes());
        if name == "." || name == ".." {
            continue;
        }
        let directory = match entry.file_type() {
            FileType::Unknown => kind(dir, name)? == FileType::Directory,
            kind => kind == FileType::Directory,
        };
        entries.push((name.to_os_string(), directory));
    }
    Ok(entries)
}

/// Secret-named entries below `root`, relative to it and sorted. Discovery
/// (`bounded`) fails closed on anything it cannot inspect. Cleanup instead
/// reports such a directory itself, so the caller quarantines it whole: an
/// unreadable or over-deep directory can no longer hide a new secret.
pub(super) fn walk(root: &Path, bounded: bool) -> io::Result<Vec<PathBuf>> {
    let dir = open_root(root)?;
    let names = entries(&dir)?;
    let mut walk = Walk {
        bounded,
        visited: 0,
        found: Vec::new(),
    };
    walk.visit(&dir, names, Path::new(""), 0)?;
    walk.found.sort();
    Ok(walk.found)
}

struct Walk {
    bounded: bool,
    visited: usize,
    found: Vec<PathBuf>,
}

impl Walk {
    fn visit(
        &mut self,
        dir: &OwnedFd,
        names: Vec<(OsString, bool)>,
        relative: &Path,
        depth: usize,
    ) -> io::Result<()> {
        for (name, directory) in names {
            self.visited += 1;
            if self.bounded && self.visited > MAX_ENTRIES {
                return Err(io::Error::other(
                    "project secret discovery entry limit exceeded",
                ));
            }
            let path = relative.join(&name);
            if crate::command_sandbox::secret_name(&name.to_string_lossy()) {
                // Existing protected directories are excluded, not scanned.
                self.found.push(path);
                continue;
            }
            if !directory {
                continue;
            }
            let child = if depth >= MAX_DEPTH {
                Err(io::Error::other("project secret discovery depth exceeded"))
            } else {
                open_child(dir, &name).and_then(|child| Ok((entries(&child)?, child)))
            };
            match child {
                Ok((names, child)) => self.visit(&child, names, &path, depth + 1)?,
                Err(error) if self.bounded => return Err(error),
                Err(_) => self.found.push(path),
            }
        }
        Ok(())
    }
}
