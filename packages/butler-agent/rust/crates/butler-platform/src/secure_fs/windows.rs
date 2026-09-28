//! Windows: files inherit the data folder's ACL (an owner-only ACL comes in
//! the Windows stage), there is no directory exchange and no inode.

use std::fs::{self, DirBuilder, File, Metadata, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::{ExchangeError, FileIdentity, FileTime, Writability};

pub(super) fn create_private_dir_all(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)
}

pub(super) fn create_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir(path)
}

pub(super) fn owner_only_dirs(builder: &mut DirBuilder) -> &mut DirBuilder {
    builder
}

pub(super) fn owner_only(options: &mut OpenOptions) -> &mut OpenOptions {
    options
}

/// Directories cannot be opened (and synced) like files here.
pub(super) fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

pub(super) fn same_file(left: &Metadata, right: &Metadata) -> bool {
    left.len() == right.len() && left.modified().ok() == right.modified().ok()
}

pub(super) fn creation_mode(options: &mut OpenOptions, _mode: u32) -> &mut OpenOptions {
    options
}

pub(super) fn file_mode(_metadata: &Metadata) -> Option<u32> {
    None
}

pub(super) fn restrict_file(_path: &Path) -> io::Result<()> {
    Ok(())
}

pub(super) fn restrict_open_file(_file: &File) -> io::Result<()> {
    Ok(())
}

pub(super) fn restrict_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// Private files keep the inherited ACL for now, so every file is as private
/// as this host makes them.
pub(super) fn is_owner_only(_metadata: &Metadata) -> bool {
    true
}

pub(super) fn no_follow(options: &mut OpenOptions) -> &mut OpenOptions {
    options
}

pub(super) fn open_read_no_follow(path: &Path) -> io::Result<File> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::other("the path is a symbolic link"));
    }
    File::open(path)
}

pub(super) fn exchange_directories(_left: &Path, _right: &Path) -> Result<(), ExchangeError> {
    Err(ExchangeError::Unsupported)
}

pub(super) fn identity(metadata: &Metadata) -> FileIdentity {
    FileIdentity {
        device: 0,
        inode: 0,
        modified: metadata.modified().ok().and_then(epoch_time),
        changed: metadata.created().ok().and_then(epoch_time),
    }
}

fn epoch_time(value: SystemTime) -> Option<FileTime> {
    let duration = value.duration_since(UNIX_EPOCH).ok()?;
    Some(FileTime {
        seconds: i64::try_from(duration.as_secs()).ok()?,
        nanoseconds: i64::from(duration.subsec_nanos()),
    })
}

pub(super) fn directory_writability(path: &Path) -> Writability {
    if fs::metadata(path).is_ok_and(|metadata| metadata.permissions().readonly()) {
        Writability::Denied
    } else {
        Writability::Writable
    }
}

pub(super) fn path_key(path: &Path) -> PathBuf {
    PathBuf::from(path.to_string_lossy().replace('\\', "/").to_lowercase())
}

pub(super) fn symlink(target: &Path, link: &Path) -> io::Result<()> {
    let directory = link
        .parent()
        .map_or_else(|| target.to_path_buf(), |parent| parent.join(target))
        .is_dir();
    if directory {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    }
}
