//! Windows: no owner-only permissions, no-follow opens, file ids, directory
//! syncs or atomic directory exchange yet. Each of these reports `None` or
//! `Unsupported`; directories and files are still created, and renames are
//! retried while another process briefly holds a file.
//!
//! Files get no owner-only mode of their own: they inherit the access list of
//! their folder. A folder [`protect_folder`] restricted (and every folder
//! [`create_private_dir_all`] creates) grants full control to the current
//! account and the system only, through `icacls` by absolute path, so no
//! unsafe Win32 calls are needed. [`is_private`] reads a list back the same
//! way. [`OWNER_ONLY`] stays `false`: it describes per-file modes, which
//! Windows lacks, and `is_owner_only` cannot tell from metadata.

use std::fs::{self, DirBuilder, File, Metadata, OpenOptions};
use std::io;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
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
    fs::create_dir_all(path)?;
    match top {
        Some(top) => grant(top, true),
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

/// The account that runs this process: `whoami /user` names it and its SID.
struct Account {
    name: String,
    sid: String,
}

fn account() -> Option<&'static Account> {
    static ACCOUNT: OnceLock<Option<Account>> = OnceLock::new();
    ACCOUNT
        .get_or_init(|| {
            let output = system_tool("whoami")
                .args(["/user", "/fo", "csv", "/nh"])
                .output()
                .ok()
                .filter(|output| output.status.success())?;
            let text = String::from_utf8_lossy(&output.stdout).into_owned();
            let mut fields = text.trim().split("\",\"");
            let name = fields.next()?.trim_start_matches('"').to_owned();
            let sid = fields.next()?.trim_end_matches('"').to_owned();
            sid.starts_with("S-1-").then_some(Account { name, sid })
        })
        .as_ref()
}

/// A tool of the Windows system folder, by absolute path and without a
/// console window.
fn system_tool(name: &str) -> Command {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let mut command = Command::new(PathBuf::from(root).join("System32").join(name));
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// `CREATE_NO_WINDOW`.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// The local system account, which keeps access so services and backups work.
const SYSTEM_SID: &str = "S-1-5-18";

/// Removes the inherited access list of `path` and grants full control to
/// the current account and the system only; a folder's grant is inherited by
/// what is created in it (`icacls`, so no unsafe Win32 calls are needed).
fn grant(path: &Path, folder: bool) -> io::Result<()> {
    let account = account().ok_or_else(|| io::Error::other("the current account is unknown"))?;
    let rights = if folder { "(OI)(CI)F" } else { "F" };
    let output = system_tool("icacls")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("*{}:{rights}", account.sid))
        .arg(format!("*{SYSTEM_SID}:{rights}"))
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "icacls could not restrict the folder: {}",
            String::from_utf8_lossy(&output.stdout).trim()
        )))
    }
}

/// Reads the access list with `icacls`: private when only the current
/// account and the system are on it.
pub(super) fn is_private(path: &Path) -> Option<bool> {
    let account = account()?;
    let output = system_tool("icacls").arg(path).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let shown = path.display().to_string();
    let mut entries = 0;
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix(shown.as_str()).unwrap_or(line).trim();
        let Some((who, rights)) = line.split_once(":(") else {
            continue;
        };
        if !rights.contains(')') {
            continue;
        }
        entries += 1;
        let who = who.trim();
        let system = who.eq_ignore_ascii_case("NT AUTHORITY\\SYSTEM") || who == SYSTEM_SID;
        if !(system || who.eq_ignore_ascii_case(&account.name) || who == account.sid) {
            return Some(false);
        }
    }
    (entries > 0).then_some(true)
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
