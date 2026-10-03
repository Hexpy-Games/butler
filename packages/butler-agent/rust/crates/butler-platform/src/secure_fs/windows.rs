//! Windows private DACLs grant only the current user. No SYSTEM or
//! Administrators ACE is needed for this per-user background process.
//! No-follow opens, file ids and atomic directory exchange
//! remain unavailable. OWNER_ONLY describes Unix metadata modes, not ACLs.

use std::fs::{self, DirBuilder, File, Metadata, OpenOptions};
use std::io;
use std::os::windows::fs::OpenOptionsExt;

#[cfg(feature = "test-support")]
pub(super) fn discard_cached_pages(_: &File) -> Option<io::Result<()>> {
    None
}
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
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
const RENAME_ATTEMPTS: u32 = 10;
const RENAME_BACKOFF: std::time::Duration = std::time::Duration::from_millis(20);

/// Creates the folder and its missing parents; the topmost one created is
/// restricted to its owner, and everything below inherits that.
pub(super) fn create_private_dir_all(path: &Path) -> io::Result<()> {
    let top = path
        .ancestors()
        .take_while(|folder| !folder.exists())
        .last();
    match top {
        Some(top) => {
            // Protect before creating descendants, so they inherit only our ACL.
            fs::create_dir_all(top)?;
            grant(top, true)?;
            fs::create_dir_all(path)
        }
        None => Ok(()),
    }
}

pub(super) fn create_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir(path)?;
    grant(path, true)
}

pub(super) fn protect_folder(path: &Path) -> Option<io::Result<()>> {
    Some(grant(path, true))
}

/// Replace the DACL rather than adding grants: unrelated explicit ACEs must
/// disappear too. SID-based inspection avoids localized icacls display text.
fn acl(path: &Path, operation: &str) -> io::Result<String> {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let powershell = PathBuf::from(root).join("System32/WindowsPowerShell/v1.0");
    let output = Command::new(powershell.join("powershell.exe"))
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
        .arg(include_str!("windows/acl.ps1"))
        .env("BUTLER_ACL_PATH", fs::canonicalize(path)?)
        .env("BUTLER_ACL_OPERATION", operation)
        // A pwsh parent exports modules incompatible with Windows PowerShell.
        // Only load this host's trusted, built-in ACL cmdlets.
        .env("PSModulePath", powershell.join("Modules"))
        .creation_flags(0x0800_0000)
        .output()?;
    if !output.status.success() {
        // The script only inspects ACL metadata, never file contents or tokens.
        return Err(io::Error::other(format!(
            "Windows private ACL operation failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn grant(path: &Path, _folder: bool) -> io::Result<()> {
    acl(path, "protect").map(|_| ())
}

pub(super) fn is_private(path: &Path) -> Option<bool> {
    match acl(path, "inspect").ok()?.as_str() {
        "True" => Some(true),
        "False" => Some(false),
        _ => None,
    }
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

pub(super) fn restrict_file(path: &Path) -> Option<io::Result<()>> {
    Some(grant(path, false))
}

pub(super) fn restrict_open_file(_file: &File) -> Option<io::Result<()>> {
    None
}

pub(super) fn restrict_directory(path: &Path) -> Option<io::Result<()>> {
    Some(grant(path, true))
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

/// Directory handles require backup semantics. Some Windows filesystems
/// refuse write access or FlushFileBuffers for directories; report that
/// limitation rather than claiming the directory entries were flushed.
pub(super) fn sync_directory(path: &Path) -> Option<io::Result<()>> {
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let result = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        // File::sync_all calls FlushFileBuffers on Windows.
        .and_then(|directory| directory.sync_all());
    match result {
        // ERROR_INVALID_FUNCTION, ACCESS_DENIED, INVALID_HANDLE,
        // NOT_SUPPORTED: Windows may disallow directory flushing.
        Err(error) if matches!(error.raw_os_error(), Some(1 | 5 | 6 | 50)) => None,
        result => Some(result),
    }
}

pub(super) fn sync_path(path: &Path) -> io::Result<()> {
    if fs::metadata(path)?.is_dir() {
        return sync_directory(path).unwrap_or(Ok(()));
    }
    OpenOptions::new().write(true).open(path)?.sync_all()
}

pub(super) fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    dunce::canonicalize(path)
}

pub(super) fn rename(from: &Path, to: &Path) -> io::Result<()> {
    let from = move_path(from)?;
    let to = move_path(to)?;
    let mut attempt = 1;
    loop {
        // The safe wrapper calls MoveFileExW with REPLACE_EXISTING | WRITE_THROUGH.
        let result = atomicwrites::replace_atomic(&from, &to);
        match result {
            Err(error) if attempt < RENAME_ATTEMPTS && is_transient(&error) => {
                attempt += 1;
                std::thread::sleep(RENAME_BACKOFF);
            }
            result => return result,
        }
    }
}

/// Canonicalize only the parent: the destination need not exist, and a
/// rename must move a link itself. std canonicalization keeps the extended
/// path prefix so MoveFileExW works beyond MAX_PATH even in test executables.
fn move_path(path: &Path) -> io::Result<PathBuf> {
    if path.as_os_str().as_encoded_bytes().contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains NUL",
        ));
    }
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "rename requires a file name")
    })?;
    Ok(fs::canonicalize(parent)?.join(name))
}

/// Another process has the file open without sharing its deletion (access
/// denied is also what a file pending deletion reports).
fn is_transient(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || error
            .raw_os_error()
            .is_some_and(|code| SHARING_ERRORS.contains(&code))
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

pub(super) fn hard_link_unsupported(error: &io::Error) -> bool {
    // ERROR_INVALID_FUNCTION / ERROR_NOT_SUPPORTED.
    matches!(error.raw_os_error(), Some(1 | 50))
}
