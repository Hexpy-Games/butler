//! Owner-only files and directories, atomic replacement, no-follow opens,
//! directory exchange and file identity.
//!
//! Unix expresses "only the owner" with permission bits (0700 directories and
//! 0600 files) and exchanges directories with `renameat2`/`renamex_np`.
//! Windows inherits the data folder's ACL for now (an owner-only ACL comes in
//! the Windows stage), has no directory exchange and follows links.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// Creates `path` and its missing parents as directories only the owner may
/// use. An existing directory is left as it is.
pub fn create_private_dir_all(path: &Path) -> io::Result<()> {
    sys::create_private_dir_all(path)
}

/// Creates the directory `path` (its parent must exist) for the owner only.
/// An existing entry fails with [`io::ErrorKind::AlreadyExists`].
pub fn create_private_dir(path: &Path) -> io::Result<()> {
    sys::create_private_dir(path)
}

/// Makes `options` create files only the owner may read and write.
pub fn owner_only(options: &mut OpenOptions) -> &mut OpenOptions {
    sys::owner_only(options)
}

/// Makes `options` create files with the permission `mode` another file had
/// (see [`file_mode`]).
pub fn creation_mode(options: &mut OpenOptions, mode: u32) -> &mut OpenOptions {
    sys::creation_mode(options, mode)
}

/// The permission mode of a file, on hosts with permission bits.
pub fn file_mode(metadata: &Metadata) -> Option<u32> {
    sys::file_mode(metadata)
}

/// Restricts an existing file to its owner.
pub fn restrict_file(path: &Path) -> io::Result<()> {
    sys::restrict_file(path)
}

/// Restricts the open `file` to its owner, whatever path it has now.
pub fn restrict_open_file(file: &File) -> io::Result<()> {
    sys::restrict_open_file(file)
}

/// Whether the file or directory `metadata` describes is exactly as private
/// as [`owner_only`], [`restrict_file`] and [`restrict_directory`] make it.
pub fn is_owner_only(metadata: &Metadata) -> bool {
    sys::is_owner_only(metadata)
}

/// Restricts an existing directory to its owner.
pub fn restrict_directory(path: &Path) -> io::Result<()> {
    sys::restrict_directory(path)
}

/// Makes `options` refuse to open a symbolic link as the final path
/// component (`O_NOFOLLOW`). Windows opens are not reparse-point safe yet and
/// `options` stay as they are there.
pub fn no_follow(options: &mut OpenOptions) -> &mut OpenOptions {
    sys::no_follow(options)
}

/// Opens the file at `path` for reading, refusing a symbolic link as the
/// final path component (on Windows by checking the path before opening it).
pub fn open_read_no_follow(path: &Path) -> io::Result<File> {
    sys::open_read_no_follow(path)
}

/// Atomically replaces `path` with a new owner-only file: `write` fills the
/// new file at `temporary` (which must not exist, next to `path`), which is
/// synced and renamed over `path`. On failure the temporary file is removed
/// and `path` is untouched.
pub fn replace_private(
    path: &Path,
    temporary: &Path,
    write: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        owner_only(&mut options);
        let mut file = options.open(temporary)?;
        write(&mut file)?;
        file.sync_all()?;
        drop(file);
        fs::rename(temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

/// Why two directories were not exchanged.
#[derive(Debug, thiserror::Error)]
pub enum ExchangeError {
    /// Reading either directory or the exchange itself failed.
    #[error(transparent)]
    Io(io::Error),
    /// The directories are on different file systems.
    #[error("the directories are on different file systems")]
    CrossDevice,
    /// This host cannot exchange directories atomically.
    #[error("atomic directory exchange is unsupported on this host")]
    Unsupported,
}

/// Atomically swaps two directories on the same file system.
pub fn exchange_directories(left: &Path, right: &Path) -> Result<(), ExchangeError> {
    sys::exchange_directories(left, right)
}

/// What identifies a file's content version on this host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileIdentity {
    /// The device holding the file, or 0 on hosts that do not report it.
    pub device: u64,
    /// The inode number, or 0 on hosts without inodes.
    pub inode: u64,
    /// When the file's status last changed (Unix `ctime`; the creation time
    /// elsewhere, when it is known and not before the epoch).
    pub changed: Option<FileTime>,
}

/// A file timestamp as the host reports it: seconds and nanoseconds since the
/// Unix epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileTime {
    /// Whole seconds since the epoch.
    pub seconds: i64,
    /// Nanoseconds within the second.
    pub nanoseconds: i64,
}

impl FileTime {
    /// Milliseconds since the epoch, with the sub-millisecond fraction.
    pub fn millis(self) -> f64 {
        self.seconds as f64 * 1000.0 + self.nanoseconds as f64 / 1_000_000.0
    }
}

/// The identity of the file `metadata` describes.
pub fn identity(metadata: &Metadata) -> FileIdentity {
    sys::identity(metadata)
}

/// Whether this user may create entries in a directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Writability {
    /// Entries can be created.
    Writable,
    /// The directory does not exist.
    Missing,
    /// Permission is denied.
    Denied,
    /// The check itself failed.
    Unknown,
}

/// Whether this user may create entries in the directory at `path`.
pub fn directory_writability(path: &Path) -> Writability {
    sys::directory_writability(path)
}

/// The form of `path` two paths are compared in: as is where the file system
/// is case-sensitive, lowercased with `/` separators on Windows.
pub fn path_key(path: &Path) -> PathBuf {
    sys::path_key(path)
}

/// Creates a symbolic link at `link` that points to `target`.
pub fn symlink(target: &Path, link: &Path) -> io::Result<()> {
    sys::symlink(target, link)
}
