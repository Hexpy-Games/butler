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
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::replace_retry::{DeleteProbe, replacement_retry_allowed};
use super::{ExchangeError, FileIdentity, FileMode, FileTime, Writability};
mod acl;

pub(super) const OWNER_ONLY: bool = false;
pub(super) const PERMISSION_MODES: bool = false;
pub(super) const NO_FOLLOW: bool = false;
pub(super) const FILE_IDS: bool = false;
pub(super) const DIRECTORY_SYNC: bool = false;
pub(super) const ATOMIC_EXCHANGE: bool = false;

const REPLACEMENT_ATTEMPTS: u32 = 20;
const REPLACEMENT_BACKOFF: std::time::Duration = std::time::Duration::from_millis(50);

pub(super) fn current_metadata(path: &Path) -> io::Result<Metadata> {
    // FindFirstFile attributes may lag prior NTFS writes. A metadata-only
    // handle also supports directories, without reading contents or enabling
    // backup privileges. File::metadata queries GetFileInformationByHandle.
    OpenOptions::new()
        .read(true)
        .access_mode(0)
        // FILE_FLAG_BACKUP_SEMANTICS for directories, OPEN_REPARSE_POINT for
        // attributes of the entry itself, matching directory enumeration.
        .custom_flags(0x0220_0000)
        .open(path)?
        .metadata()
}

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

fn grant(path: &Path, _folder: bool) -> io::Result<()> {
    acl::protect(path)
}

pub(super) fn is_private(path: &Path) -> Option<bool> {
    acl::inspect(path).ok()
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

// A failed handle query cannot establish that the file has no outside alias.
pub(super) fn has_other_links(path: &Path, metadata: &Metadata) -> bool {
    if !metadata.is_file() {
        return false;
    }
    link_count(path).is_none_or(|count| count > 1)
}
fn link_count(path: &Path) -> Option<u32> {
    use winsafe::{HFILE, co};
    let (handle, _) = HFILE::CreateFile(
        path.to_str()?,
        co::GENERIC::default(),
        Some(co::FILE_SHARE::READ | co::FILE_SHARE::WRITE | co::FILE_SHARE::DELETE),
        None,
        co::DISPOSITION::OPEN_EXISTING,
        co::FILE_ATTRIBUTE::NORMAL,
        Some(co::FILE_FLAG::OPEN_REPARSE_POINT),
        None,
        None,
    )
    .ok()?;
    Some(handle.GetFileInformationByHandle().ok()?.nNumberOfLinks)
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

#[allow(
    clippy::disallowed_methods,
    reason = "the implementation behind secure_fs::canonicalize"
)]
pub(super) fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    dunce::canonicalize(path)
}

pub(super) fn record_key(key: &str) -> std::borrow::Cow<'_, str> {
    let stem = key.split('.').next().unwrap_or(key).to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
        });
    if !device
        && !key.starts_with('~')
        && !key.ends_with(['.', ' '])
        && !key
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return std::borrow::Cow::Borrowed(key);
    }
    let mut encoded = String::from("~");
    for byte in key.as_bytes() {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    std::borrow::Cow::Owned(encoded)
}

pub(super) fn rename(from: &Path, to: &Path) -> io::Result<()> {
    let from = move_path(from)?;
    let to = move_path(to)?;
    let mut attempt = 1;
    loop {
        // The safe wrapper calls MoveFileExW with REPLACE_EXISTING | WRITE_THROUGH.
        let result = atomicwrites::replace_atomic(&from, &to);
        match result {
            Err(error)
                if attempt < REPLACEMENT_ATTEMPTS
                    && replacement_is_transient(&error, &from, &to) =>
            {
                attempt += 1;
                std::thread::sleep(REPLACEMENT_BACKOFF);
            }
            result => return result,
        }
    }
}

pub(super) fn replace_file(
    from: &Path,
    to: &Path,
    before_retry: &mut dyn FnMut() -> io::Result<()>,
) -> io::Result<()> {
    let from = move_path(from)?;
    let to = move_path(to)?;
    let mut attempt = 1;
    loop {
        // Retain std's FileRenameInfoEx/POSIX fallback for delete-shared
        // readers, including a reader of an unlinked hard-link alias.
        let result = fs::rename(&from, &to);
        if let Err(error) = &result
            && std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
                == Some(std::ffi::OsStr::new("1"))
        {
            eprintln!(
                "command_file_error phase=replace_attempt attempt={attempt} kind={:?} os_code={:?}",
                error.kind(),
                error.raw_os_error()
            );
        }
        match result {
            Err(error)
                if attempt < REPLACEMENT_ATTEMPTS
                    && replacement_is_transient(&error, &from, &to) =>
            {
                attempt += 1;
                std::thread::sleep(REPLACEMENT_BACKOFF);
                before_retry()?;
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
    Ok(super::canonicalize_extended(parent)?.join(name))
}

pub(super) fn replacement_is_transient(error: &io::Error, from: &Path, to: &Path) -> bool {
    replacement_retry_allowed(error.raw_os_error(), || delete_probes(from, to))
}

/// Probe source DELETE and target DELETE, or parent FILE_ADD_FILE for creation.
/// Read-only targets and metadata failures do not permit retry.
fn delete_probes(from: &Path, to: &Path) -> Option<[DeleteProbe; 2]> {
    let (target, access) = match current_metadata(to) {
        Ok(metadata) if metadata.is_file() && metadata.permissions().readonly() => return None,
        Ok(_) => (to, 0x0001_0000),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            (to.parent().unwrap_or(Path::new(".")), 0x0000_0002)
        }
        Err(_) => return None,
    };
    Some([("source", from, 0x0001_0000), ("target", target, access)].map(|(role, path, access)| {
        // Share all access without changing the probed entry, and
        // inspect reparse entries themselves. Every probe handle closes here,
        // before the next rename attempt or its backoff.
        let result = OpenOptions::new()
            .read(true)
            .access_mode(access)
            .share_mode(7)
            .custom_flags(0x0220_0000)
            .open(path);
        let os_code = result.as_ref().err().and_then(io::Error::raw_os_error);
        if std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
            == Some(std::ffi::OsStr::new("1"))
        {
            eprintln!(
                "command_file_error phase=rename os_code=Some(5) probe=delete role={role} probe_os_code={os_code:?}"
            );
        }
        result.map(drop).map_err(|_| os_code)
    }))
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
    let key = path.to_string_lossy().replace('\\', "/").to_lowercase();
    if let Some(share) = key.strip_prefix("//?/unc/") {
        return PathBuf::from(format!("//{share}"));
    }
    match key.strip_prefix("//?/") {
        Some(disk) if disk.as_bytes().get(1) == Some(&b':') => PathBuf::from(disk),
        _ => PathBuf::from(key),
    }
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
