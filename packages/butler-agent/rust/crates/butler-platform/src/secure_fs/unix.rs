//! Permission bits, `renameat2`/`renamex_np` exchange and inode identity.

use std::fs::{self, DirBuilder, File, Metadata, OpenOptions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use nix::errno::Errno;
use nix::unistd::{AccessFlags, access};

use super::{ExchangeError, FileIdentity, FileTime, Writability};

const PRIVATE_DIRECTORY: u32 = 0o700;
const PRIVATE_FILE: u32 = 0o600;
const PERMISSION_BITS: u32 = 0o777;

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

pub(super) fn owner_only_dirs(builder: &mut DirBuilder) -> &mut DirBuilder {
    builder.mode(PRIVATE_DIRECTORY)
}

pub(super) fn owner_only(options: &mut OpenOptions) -> &mut OpenOptions {
    options.mode(PRIVATE_FILE)
}

pub(super) fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path).and_then(|directory| directory.sync_all())
}

pub(super) fn same_file(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

pub(super) fn creation_mode(options: &mut OpenOptions, mode: u32) -> &mut OpenOptions {
    options.mode(mode)
}

pub(super) fn file_mode(metadata: &Metadata) -> Option<u32> {
    Some(metadata.permissions().mode())
}

pub(super) fn restrict_file(path: &Path) -> io::Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(PRIVATE_FILE))
}

pub(super) fn restrict_open_file(file: &File) -> io::Result<()> {
    file.set_permissions(fs::Permissions::from_mode(PRIVATE_FILE))
}

pub(super) fn restrict_directory(path: &Path) -> io::Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(PRIVATE_DIRECTORY))
}

pub(super) fn is_owner_only(metadata: &Metadata) -> bool {
    let private = if metadata.is_dir() {
        PRIVATE_DIRECTORY
    } else {
        PRIVATE_FILE
    };
    metadata.permissions().mode() & PERMISSION_BITS == private
}

pub(super) fn no_follow(options: &mut OpenOptions) -> &mut OpenOptions {
    options.custom_flags(nix::libc::O_NOFOLLOW)
}

pub(super) fn open_read_no_follow(path: &Path) -> io::Result<File> {
    no_follow(OpenOptions::new().read(true)).open(path)
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
        device: metadata.dev(),
        inode: metadata.ino(),
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
