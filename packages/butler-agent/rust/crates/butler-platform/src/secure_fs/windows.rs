//! Windows: no owner-only permissions, no-follow opens, file ids or
//! directory syncs yet (the Windows stage adds an owner-only ACL on the data
//! folder, reparse-point-safe opens and handle-based file ids). Each of these
//! reports `None`; directories and files are still created.

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

/// Clears the read-only attribute of every file and directory under `root`.
pub(super) fn make_tree_writable(root: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(root)?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    let mut permissions = metadata.permissions();
    if permissions.readonly() {
        // The read-only attribute is all a Windows file permission is.
        #[allow(
            clippy::permissions_set_readonly_false,
            reason = "Windows has only the read-only attribute; there is no world-writable bit to grant"
        )]
        permissions.set_readonly(false);
        fs::set_permissions(root, permissions)?;
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(root)? {
            make_tree_writable(&entry?.path())?;
        }
    }
    Ok(())
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
