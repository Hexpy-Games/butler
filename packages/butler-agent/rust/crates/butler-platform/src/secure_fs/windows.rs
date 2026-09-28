//! Windows: no owner-only permissions, no-follow opens, file ids, directory
//! syncs or atomic directory exchange yet. Each of these reports `None` or
//! `Unsupported`; directories and files are still created, and renames are
//! retried while another process briefly holds a file.
//!
//! Files get the access list they inherit from their folder. The default
//! DATA folder, `%USERPROFILE%\.butler`, inherits the user profile's list
//! (the user, SYSTEM and Administrators), so other users cannot read it; a
//! DATA folder elsewhere is not restricted. Setting an owner-only access
//! list needs the Win32 security API, which no maintained crate offers
//! without `unsafe` here, so [`OWNER_ONLY`] stays `false` until one does.

use std::fs::{self, DirBuilder, File, Metadata, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::{ExchangeError, FileIdentity, FileMode, FileTime, Writability};

pub(super) const OWNER_ONLY: bool = false;
pub(super) const PERMISSION_MODES: bool = false;
pub(super) const NO_FOLLOW: bool = false;
pub(super) const FILE_IDS: bool = false;
pub(super) const DIRECTORY_SYNC: bool = false;
pub(super) const ATOMIC_EXCHANGE: bool = false;

/// `ERROR_SHARING_VIOLATION` and `ERROR_LOCK_VIOLATION`.
const SHARING_ERRORS: [i32; 2] = [32, 33];
/// How often, and how far apart, a refused rename is retried.
const RENAME_ATTEMPTS: u32 = 20;
const RENAME_BACKOFF: std::time::Duration = std::time::Duration::from_millis(50);

pub(super) fn create_private_dir_all(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)
}

pub(super) fn create_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir(path)
}

pub(super) fn owner_only_dirs(_builder: &mut DirBuilder) -> Option<&mut DirBuilder> {
    None
}

pub(super) fn owner_only(_options: &mut OpenOptions) -> Option<&mut OpenOptions> {
    None
}

pub(super) fn creation_mode(
    _options: &mut OpenOptions,
    _mode: FileMode,
) -> Option<&mut OpenOptions> {
    None
}

pub(super) fn file_mode(_metadata: &Metadata) -> Option<FileMode> {
    None
}

pub(super) fn set_file_mode(_path: &Path, _mode: FileMode) -> Option<io::Result<()>> {
    None
}

pub(super) fn restrict_file(_path: &Path) -> Option<io::Result<()>> {
    None
}

pub(super) fn restrict_open_file(_file: &File) -> Option<io::Result<()>> {
    None
}

pub(super) fn restrict_directory(_path: &Path) -> Option<io::Result<()>> {
    None
}

pub(super) fn is_owner_only(_metadata: &Metadata) -> Option<bool> {
    None
}

pub(super) fn no_follow(_options: &mut OpenOptions) -> Option<&mut OpenOptions> {
    None
}

/// Checks the path before opening it; a link swapped in between is followed.
pub(super) fn open_read_no_follow(path: &Path) -> io::Result<File> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::other("the path is a symbolic link"));
    }
    File::open(path)
}

pub(super) fn sync_directory(_path: &Path) -> Option<io::Result<()>> {
    None
}

pub(super) fn sync_path(path: &Path) -> io::Result<()> {
    if fs::metadata(path)?.is_dir() {
        return Ok(());
    }
    OpenOptions::new().write(true).open(path)?.sync_all()
}

pub(super) fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    dunce::canonicalize(path)
}

pub(super) fn rename(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Err(error) if attempt < RENAME_ATTEMPTS && is_transient(&error) => {
                attempt += 1;
                std::thread::sleep(RENAME_BACKOFF);
            }
            result => return result,
        }
    }
}

/// Another process has the file open without sharing its deletion (access
/// denied is also what a file pending deletion reports).
fn is_transient(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || error
            .raw_os_error()
            .is_some_and(|code| SHARING_ERRORS.contains(&code))
}

pub(super) fn exchange_directories(_left: &Path, _right: &Path) -> Result<(), ExchangeError> {
    Err(ExchangeError::Unsupported)
}

pub(super) fn identity(metadata: &Metadata) -> FileIdentity {
    FileIdentity {
        id: None,
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
    match fs::metadata(path) {
        Ok(metadata) if metadata.permissions().readonly() => Writability::Denied,
        Ok(_) => Writability::Writable,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Writability::Missing,
        Err(_) => Writability::Unknown,
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
