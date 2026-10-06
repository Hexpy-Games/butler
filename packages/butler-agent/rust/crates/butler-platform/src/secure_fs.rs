//! Owner-only files and directories, atomic replacement, no-follow opens,
//! directory exchange and file identity.
//!
//! Unix expresses "only the owner" with permission bits (0700 directories and
//! 0600 files) and exchanges directories with `renameat2`/`renamex_np`.
//! Windows has none of these yet (see `windows.rs` for what protects DATA
//! there): each missing capability has a flag here, and the operation
//! reports it instead of pretending: an option or builder it cannot apply
//! returns `None`. Renames that replace a file retry on Windows while
//! another process briefly holds it ([`rename`]).

mod contained_read;
mod fault;
pub use fault::{checkpoint as fault_checkpoint, write as fault_write};

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

/// Whether [`protect_folder`] and [`is_private`] work: every host can keep a
/// folder, and what is created in it, to its owner (with modes on Unix, with
/// an access list on Windows).
pub const PROTECTED_FOLDERS: bool = true;

/// Whether this host has permission modes ([`FileMode`]).
pub const PERMISSION_MODES: bool = sys::PERMISSION_MODES;

/// Whether [`no_follow`] can make an open refuse a final symbolic link.
pub const NO_FOLLOW: bool = sys::NO_FOLLOW;

/// Whether [`identity`] reports device and inode numbers ([`FileId`]).
pub const FILE_IDS: bool = sys::FILE_IDS;

/// Whether directory flushing is guaranteed to be available on this host.
/// Windows attempts it but can report unsupported for the filesystem.
pub const DIRECTORY_SYNC: bool = sys::DIRECTORY_SYNC;

/// Whether [`exchange_directories`] can swap two directories atomically.
/// Without it (Windows), callers move one directory aside and the other into
/// its place with two [`rename`]s, and journal the step between them.
pub const ATOMIC_EXCHANGE: bool = sys::ATOMIC_EXCHANGE;

/// Whether tempfile's native persist APIs support long filenames without host
/// settings changes. Windows callers must use the standard filesystem writer.
pub const TEMPFILE_LONG_PATH_PERSISTENCE: bool = !cfg!(windows);

/// A permission mode on hosts with [`PERMISSION_MODES`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileMode(#[cfg_attr(not(unix), allow(dead_code))] u32);

impl FileMode {
    /// Read and write for the owner only (0600).
    pub const OWNER_ONLY: Self = Self(0o600);
    /// Read and write for the owner, read for the group (0640).
    pub const GROUP_READABLE: Self = Self(0o640);
    /// An ordinary file: read and write for the owner, read for others
    /// (0644). Test fixtures only.
    #[cfg(feature = "test-support")]
    pub const ORDINARY: Self = Self(0o644);
    /// Read-only for everyone (0444), as an unpacked release archive leaves
    /// its files. Test fixtures only.
    #[cfg(feature = "test-support")]
    pub const READ_ONLY: Self = Self(0o444);
    /// A directory that can be searched and listed but not changed (0555),
    /// as an unpacked release archive leaves its directories. Test fixtures
    /// only.
    #[cfg(feature = "test-support")]
    pub const READ_ONLY_DIRECTORY: Self = Self(0o555);
    /// An executable file: an ordinary file everyone may run (0755). Test
    /// fixtures only.
    #[cfg(feature = "test-support")]
    pub const EXECUTABLE: Self = Self(0o755);

    /// A mode from its raw bits, as an archive entry records them.
    pub const fn from_bits(bits: u32) -> Self {
        Self(bits)
    }

    /// The raw permission bits, as an archive entry records them. Test
    /// fixtures only.
    #[cfg(feature = "test-support")]
    pub const fn bits(self) -> u32 {
        self.0
    }

    /// Whether anyone may execute a file with this mode.
    pub const fn is_executable(self) -> bool {
        self.0 & 0o111 != 0
    }
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

/// Restricts the folder `path`, and everything created in it afterwards, to
/// its owner (and the system) with an access list: the Windows way, where
/// files get no owner-only mode of their own but inherit their folder's
/// list. `None` where permission modes already do it (Unix).
pub fn protect_folder(path: &Path) -> Option<io::Result<()>> {
    sys::protect_folder(path)
}

/// Whether the file or folder at `path` is only its owner's (Windows: and the
/// system's) whatever way the host expresses it; `None` where that cannot be
/// read.
pub fn is_private(path: &Path) -> Option<bool> {
    sys::is_private(path)
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

/// Current file or directory attributes, queried independently of directory
/// enumeration caches. Does not follow links, read contents or modify the entry.
pub fn current_metadata(path: &Path) -> io::Result<Metadata> {
    sys::current_metadata(path)
}

/// Sets the permission mode of the file at `path`; `None` without
/// [`PERMISSION_MODES`].
pub fn set_file_mode(path: &Path, mode: FileMode) -> Option<io::Result<()>> {
    sys::set_file_mode(path, mode)
}

/// Removes the directory tree at `path`, symbolic links included as links
/// (never followed), after giving the owner write access to every directory
/// and file under it: archives unpack read-only, and a read-only directory
/// cannot have its entries removed. A missing `path` is not an error.
pub fn remove_tree(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => {
            sys::make_tree_writable(path)?;
            fs::remove_dir_all(path)
        }
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
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

/// Opens a private append stream, refusing a final symlink where supported
/// and repairing broad legacy modes on the opened inode. Callers choose the
/// stream's flush/durability policy and establish its private parent.
pub fn append_private(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    owner_only(&mut options);
    no_follow(&mut options);
    let file = options.open(path)?;
    restrict_open_file(&file).unwrap_or(Ok(()))?;
    Ok(file)
}

/// Advises the kernel to discard this fixture file's cached pages, for cold
/// performance measurements. Never changes the host's global cache policy.
#[cfg(feature = "test-support")]
pub fn discard_cached_pages(file: &File) -> Option<io::Result<()>> {
    sys::discard_cached_pages(file)
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

/// Reads a regular file below an anchored root, refusing symlink components.
pub fn open_read_beneath(root: &Path, relative: &Path) -> io::Result<File> {
    contained_read::open(root, relative)
}

/// Opens the file at `path` for reading, refusing a symbolic link as the
/// final path component. Without [`NO_FOLLOW`] the path is checked before it
/// is opened.
pub fn open_read_no_follow(path: &Path) -> io::Result<File> {
    sys::open_read_no_follow(path)
}

/// Flushes the directory entries of `path` (a rename or a new file in it) to
/// storage; `None` when unsupported. Windows attempts a directory flush
/// even though [`DIRECTORY_SYNC`] is false (support varies by filesystem).
pub fn sync_directory(path: &Path) -> Option<io::Result<()>> {
    sys::sync_directory(path)
}

/// Flushes the file or directory at `path` to storage: an fsync of a
/// descriptor opened for reading on Unix. Windows flushes only through a
/// handle opened for writing, so a file is opened that way there; a
/// directory flush is attempted where supported. Windows renames also
/// request write-through independently of directory flush support.
pub fn sync_path(path: impl AsRef<Path>) -> io::Result<()> {
    sys::sync_path(path.as_ref())
}

/// Atomically replaces `path` with a private file: Unix creation modes or
/// Windows ACLs restrict the empty staging file before `write` fills it. The
/// temporary file next to `path` is
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
    // On ACL hosts an existing parent may still have explicit broad ACEs.
    // Restrict the empty staging file before any secret content is written.
    let private = if OWNER_ONLY {
        Ok(())
    } else {
        restrict_file(&temporary)
            .unwrap_or(Ok(()))
            .map_err(&io_error)
    };
    let written = private.and_then(|()| write(&mut file)).and_then(|()| {
        file.sync_all().map_err(&io_error)?;
        drop(file);
        rename(&temporary, path).map_err(&io_error)
    });
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    sync_directory(parent).unwrap_or(Ok(())).map_err(io_error)
}

/// Renames `from` to `to`, replacing a file at `to`, like [`fs::rename`].
/// Windows refuses the rename while another process (a reader, an indexer,
/// an antivirus scan) has either file open without sharing its deletion; it
/// is retried for up to a second there before the error is returned.
pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    sys::rename(from, to)
}

/// A logical record key as a regular filename component. Unix keeps its
/// existing spelling; Windows encodes names with reserved characters or
/// device names. The logical key stored inside the record does not change.
pub fn record_key(key: &str) -> std::borrow::Cow<'_, str> {
    sys::record_key(key)
}

/// `.<name>.<pid>.<sequence>.<nanos>.tmp` next to `path`, unique within this
/// process and practically unique across processes.
pub(crate) fn unique_temporary(path: &Path) -> PathBuf {
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

/// Atomically swaps two directories on the same file system; unsupported
/// without [`ATOMIC_EXCHANGE`].
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

/// The absolute path of `path` with every link resolved, like
/// [`fs::canonicalize`], but in the form the rest of the host understands:
/// Windows returns resolved paths with the `\\?\` prefix, which `cmd.exe`
/// rejects as a working directory and which never matches a path spelled
/// without it, so the prefix is dropped wherever the path does not need it.
/// Every canonical path Butler compares or hands to a program comes from
/// here, so all of them share one form.
pub fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    sys::canonicalize(path.as_ref())
}

/// [`canonicalize`] as a method, in place of [`Path::canonicalize`].
pub trait Canonical {
    /// See [`canonicalize`].
    fn canonical(&self) -> io::Result<PathBuf>;
}

impl<P: AsRef<Path> + ?Sized> Canonical for P {
    fn canonical(&self) -> io::Result<PathBuf> {
        canonicalize(self)
    }
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

/// Whether a hard link error permits trying a no-clobber create instead.
/// The fallback must still enforce destination permissions and collisions.
pub fn hard_link_unsupported(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Unsupported || sys::hard_link_unsupported(error)
}

/// Component-wise containment after the caller resolves file-system aliases.
/// Windows comparisons ignore case and normalize a needless verbatim prefix;
/// Unix comparisons retain case. A sibling with a shared string prefix is out.
pub fn path_is_within(target: &Path, root: &Path) -> bool {
    path_compare::is_within(target, root)
}

mod path_compare;
pub use path_compare::relative_path;

/// An equivalent native path spelling for public-path regression scenarios.
#[cfg(feature = "test-support")]
pub fn workspace_test_alias(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy().to_uppercase();
        PathBuf::from(format!(r"\\?\{text}"))
    }
    #[cfg(not(windows))]
    {
        path.parent()
            .unwrap_or(path)
            .join(".")
            .join(path.file_name().unwrap_or_default())
    }
}

#[cfg(feature = "test-support")]
pub mod fixture_links;
