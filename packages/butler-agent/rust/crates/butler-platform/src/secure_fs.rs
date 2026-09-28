//! Owner-only files and directories, atomic replacement, no-follow opens,
//! directory exchange and file identity.
//!
//! Unix expresses "only the owner" with permission bits (0700 directories and
//! 0600 files) and exchanges directories with `renameat2`/`renamex_np`.
//! Windows has none of these yet (an owner-only ACL on the data folder,
//! reparse-point-safe opens and file ids come in the Windows stage). Each
//! missing capability has a flag here, and the operation reports it instead
//! of pretending: an option or builder it cannot apply returns `None`.

use std::fs::{self, DirBuilder, File, Metadata, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// Whether this host can restrict files and directories to their owner.
pub const OWNER_ONLY: bool = sys::OWNER_ONLY;

/// Whether this host has permission modes ([`FileMode`]).
pub const PERMISSION_MODES: bool = sys::PERMISSION_MODES;

/// Whether [`no_follow`] can make an open refuse a final symbolic link.
pub const NO_FOLLOW: bool = sys::NO_FOLLOW;

/// Whether [`identity`] reports device and inode numbers ([`FileId`]).
pub const FILE_IDS: bool = sys::FILE_IDS;

/// Whether [`sync_directory`] can flush a directory.
pub const DIRECTORY_SYNC: bool = sys::DIRECTORY_SYNC;

/// A permission mode on hosts with [`PERMISSION_MODES`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileMode(#[cfg_attr(not(unix), allow(dead_code))] u32);

impl FileMode {
    /// Read and write for the owner only (0600).
    pub const OWNER_ONLY: Self = Self(0o600);
    /// Read and write for the owner, read for the group (0640).
    pub const GROUP_READABLE: Self = Self(0o640);
}

/// Creates `path` and its missing parents as directories, only the owner's
/// where [`OWNER_ONLY`]. An existing directory is left as it is.
pub fn create_private_dir_all(path: &Path) -> io::Result<()> {
    sys::create_private_dir_all(path)
}

/// Creates the directory `path` (its parent must exist), only the owner's
/// where [`OWNER_ONLY`]. An existing entry fails with
/// [`io::ErrorKind::AlreadyExists`].
pub fn create_private_dir(path: &Path) -> io::Result<()> {
    sys::create_private_dir(path)
}

/// Makes `builder` create directories only the owner may use; `None` (and
/// `builder` unchanged) without [`OWNER_ONLY`].
pub fn owner_only_dirs(builder: &mut DirBuilder) -> Option<&mut DirBuilder> {
    sys::owner_only_dirs(builder)
}

/// Makes `options` create files only the owner may read and write; `None`
/// (and `options` unchanged) without [`OWNER_ONLY`].
pub fn owner_only(options: &mut OpenOptions) -> Option<&mut OpenOptions> {
    sys::owner_only(options)
}

/// Makes `options` create files with `mode` (usually another file's
/// [`file_mode`]); `None` without [`PERMISSION_MODES`].
pub fn creation_mode(options: &mut OpenOptions, mode: FileMode) -> Option<&mut OpenOptions> {
    sys::creation_mode(options, mode)
}

/// The permission mode of a file; `None` without [`PERMISSION_MODES`].
pub fn file_mode(metadata: &Metadata) -> Option<FileMode> {
    sys::file_mode(metadata)
}

/// Sets the permission mode of the file at `path`; `None` without
/// [`PERMISSION_MODES`].
pub fn set_file_mode(path: &Path, mode: FileMode) -> Option<io::Result<()>> {
    sys::set_file_mode(path, mode)
}

/// Restricts an existing file to its owner; `None` without [`OWNER_ONLY`].
pub fn restrict_file(path: &Path) -> Option<io::Result<()>> {
    sys::restrict_file(path)
}

/// Restricts the open `file` to its owner, whatever path it has now; `None`
/// without [`OWNER_ONLY`].
pub fn restrict_open_file(file: &File) -> Option<io::Result<()>> {
    sys::restrict_open_file(file)
}

/// Restricts an existing directory to its owner; `None` without
/// [`OWNER_ONLY`].
pub fn restrict_directory(path: &Path) -> Option<io::Result<()>> {
    sys::restrict_directory(path)
}

/// Whether the file or directory `metadata` describes is exactly as private
/// as [`owner_only`], [`restrict_file`] and [`restrict_directory`] make it;
/// `None` without [`OWNER_ONLY`].
pub fn is_owner_only(metadata: &Metadata) -> Option<bool> {
    sys::is_owner_only(metadata)
}

/// Makes `options` refuse to open a symbolic link as the final path
/// component (`O_NOFOLLOW`); `None` (and `options` unchanged) without
/// [`NO_FOLLOW`].
pub fn no_follow(options: &mut OpenOptions) -> Option<&mut OpenOptions> {
    sys::no_follow(options)
}

/// Opens the file at `path` for reading, refusing a symbolic link as the
/// final path component. Without [`NO_FOLLOW`] the path is checked before it
/// is opened.
pub fn open_read_no_follow(path: &Path) -> io::Result<File> {
    sys::open_read_no_follow(path)
}

/// Flushes the directory entries of `path` (a rename or a new file in it) to
/// storage; `None` without [`DIRECTORY_SYNC`].
pub fn sync_directory(path: &Path) -> Option<io::Result<()>> {
    sys::sync_directory(path)
}

/// Atomically replaces `path` with a new file, only the owner's where
/// [`OWNER_ONLY`]: `write` fills a fresh temporary file next to `path`, which
/// is synced, renamed over `path`, and the rename is synced where
/// [`DIRECTORY_SYNC`]. On failure before the rename, the temporary file is
/// removed and `path` is untouched; an entry this call did not create is
/// never removed. `write` reports its own errors; `io_error` converts the
/// I/O failures of creating, syncing and renaming.
pub fn replace_private<E>(
    path: &Path,
    write: impl FnOnce(&mut File) -> Result<(), E>,
    io_error: impl Fn(io::Error) -> E,
) -> Result<(), E> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temporary = unique_temporary(path);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let _ = owner_only(&mut options);
    let mut file = options.open(&temporary).map_err(&io_error)?;
    let written = write(&mut file).and_then(|()| {
        file.sync_all().map_err(&io_error)?;
        drop(file);
        fs::rename(&temporary, path).map_err(&io_error)
    });
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    sync_directory(parent).unwrap_or(Ok(())).map_err(io_error)
}

/// `.<name>.<pid>.<sequence>.<nanos>.tmp` next to `path`, unique within this
/// process and practically unique across processes.
fn unique_temporary(path: &Path) -> PathBuf {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.subsec_nanos());
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!(
        ".{name}.{}.{sequence}.{nanos}.tmp",
        std::process::id()
    ))
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
    /// The device and inode numbers; `None` without [`FILE_IDS`].
    pub id: Option<FileId>,
    /// When the file's content last changed, when known and (off Unix) not
    /// before the epoch.
    pub modified: Option<FileTime>,
    /// When the file's status last changed (Unix `ctime`; the creation time
    /// elsewhere, when it is known and not before the epoch).
    pub changed: Option<FileTime>,
}

/// The device and inode numbers of a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FileId {
    /// The device holding the file.
    pub device: u64,
    /// The inode number.
    pub inode: u64,
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

/// Whether two metadata describe the same file: the same [`FileId`]; without
/// [`FILE_IDS`], the same length and modification time.
pub fn same_file(left: &Metadata, right: &Metadata) -> bool {
    match (identity(left).id, identity(right).id) {
        (Some(left), Some(right)) => left == right,
        _ => left.len() == right.len() && left.modified().ok() == right.modified().ok(),
    }
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
