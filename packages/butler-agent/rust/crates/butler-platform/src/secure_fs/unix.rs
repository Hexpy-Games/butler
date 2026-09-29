//! Permission bits, `renameat2`/`renamex_np` exchange and inode identity.

use std::fs::{self, DirBuilder, File, Metadata, OpenOptions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use nix::errno::Errno;
use nix::unistd::{AccessFlags, access};

use super::{ExchangeError, FileId, FileIdentity, FileMode, FileTime, Writability};

pub(super) const OWNER_ONLY: bool = true;
pub(super) const PERMISSION_MODES: bool = true;
pub(super) const NO_FOLLOW: bool = true;
pub(super) const FILE_IDS: bool = true;
pub(super) const DIRECTORY_SYNC: bool = true;
pub(super) const ATOMIC_EXCHANGE: bool = true;

const PRIVATE_DIRECTORY: u32 = 0o700;
const PRIVATE_FILE: u32 = FileMode::OWNER_ONLY.0;
/// Permission bits, without the file type.
const PERMISSION_BITS: u32 = 0o7777;
/// Read, write and execute bits of owner, group and others.
const ACCESS_BITS: u32 = 0o777;

pub(super) fn create_private_dir_all(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true).mode(PRIVATE_DIRECTORY);
    builder.create(path).or_else(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists && path.is_dir() {
            Ok(())
        } else {
            Err(error)
        }
    })
}

pub(super) fn create_private_dir(path: &Path) -> io::Result<()> {
    fs::DirBuilder::new().mode(PRIVATE_DIRECTORY).create(path)
}

pub(super) fn owner_only_dirs(builder: &mut DirBuilder) -> Option<&mut DirBuilder> {
    Some(builder.mode(PRIVATE_DIRECTORY))
}

pub(super) fn owner_only(options: &mut OpenOptions) -> Option<&mut OpenOptions> {
    Some(options.mode(PRIVATE_FILE))
}

pub(super) fn creation_mode(options: &mut OpenOptions, mode: FileMode) -> Option<&mut OpenOptions> {
    Some(options.mode(mode.0))
}

pub(super) fn file_mode(metadata: &Metadata) -> Option<FileMode> {
    Some(FileMode(metadata.permissions().mode() & PERMISSION_BITS))
}

pub(super) fn set_file_mode(path: &Path, mode: FileMode) -> Option<io::Result<()>> {
    Some(fs::set_permissions(
        path,
        fs::Permissions::from_mode(mode.0),
    ))
}

/// Gives the owner access to every directory (read, write, search) and
/// write access to every file under `root`, links not followed.
pub(super) fn make_tree_writable(root: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(root)?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    let mode = metadata.permissions().mode();
    let wanted = if metadata.is_dir() {
        mode | 0o700
    } else {
        mode | 0o200
    };
    if wanted != mode {
        fs::set_permissions(root, fs::Permissions::from_mode(wanted))?;
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(root)? {
            make_tree_writable(&entry?.path())?;
        }
    }
    Ok(())
}

pub(super) fn restrict_file(path: &Path) -> Option<io::Result<()>> {
    Some(fs::set_permissions(
        path,
        fs::Permissions::from_mode(PRIVATE_FILE),
    ))
}

pub(super) fn restrict_open_file(file: &File) -> Option<io::Result<()>> {
    Some(file.set_permissions(fs::Permissions::from_mode(PRIVATE_FILE)))
}

pub(super) fn restrict_directory(path: &Path) -> Option<io::Result<()>> {
    Some(fs::set_permissions(
        path,
        fs::Permissions::from_mode(PRIVATE_DIRECTORY),
    ))
}

pub(super) fn protect_folder(_path: &Path) -> Option<io::Result<()>> {
    None
}

pub(super) fn is_private(path: &Path) -> Option<bool> {
    is_owner_only(&fs::symlink_metadata(path).ok()?)
}

pub(super) fn is_owner_only(metadata: &Metadata) -> Option<bool> {
    let private = if metadata.is_dir() {
        PRIVATE_DIRECTORY
    } else {
        PRIVATE_FILE
    };
    Some(metadata.permissions().mode() & ACCESS_BITS == private)
}

pub(super) fn no_follow(options: &mut OpenOptions) -> Option<&mut OpenOptions> {
    Some(options.custom_flags(nix::libc::O_NOFOLLOW))
}

pub(super) fn open_read_no_follow(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)
}

pub(super) fn sync_directory(path: &Path) -> Option<io::Result<()>> {
    Some(File::open(path).and_then(|directory| directory.sync_all()))
}

pub(super) fn sync_path(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

pub(super) fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    fs::canonicalize(path)
}

pub(super) fn rename(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

pub(super) fn exchange_directories(left: &Path, right: &Path) -> Result<(), ExchangeError> {
    let left_metadata = fs::metadata(left).map_err(ExchangeError::Io)?;
    let right_metadata = fs::metadata(right).map_err(ExchangeError::Io)?;
    if left_metadata.dev() != right_metadata.dev() {
        return Err(ExchangeError::CrossDevice);
    }
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        left,
        rustix::fs::CWD,
        right,
        rustix::fs::RenameFlags::EXCHANGE,
    )
    .map_err(|error| ExchangeError::Io(error.into()))
}

pub(super) fn identity(metadata: &Metadata) -> FileIdentity {
    FileIdentity {
        id: Some(FileId {
            device: metadata.dev(),
            inode: metadata.ino(),
        }),
        modified: Some(FileTime {
            seconds: metadata.mtime(),
            nanoseconds: metadata.mtime_nsec(),
        }),
        changed: Some(FileTime {
            seconds: metadata.ctime(),
            nanoseconds: metadata.ctime_nsec(),
        }),
    }
}

pub(super) fn directory_writability(path: &Path) -> Writability {
    match access(path, AccessFlags::W_OK) {
        Ok(()) => Writability::Writable,
        Err(Errno::ENOENT) => Writability::Missing,
        Err(Errno::EACCES | Errno::EPERM) => Writability::Denied,
        Err(_) => Writability::Unknown,
    }
}

pub(super) fn path_key(path: &Path) -> PathBuf {
    path.to_path_buf()
}

pub(super) fn symlink(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}
