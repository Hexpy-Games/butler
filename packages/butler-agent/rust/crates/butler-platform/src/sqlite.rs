//! File SQLite connections using the host's path-capable VFS.
//! Database schemas, flags, transactions and state remain with their owners.
use rusqlite::{OpenFlags, Result};
mod connection;
pub use connection::Connection;
use std::path::Path;

/// Startup scans can traverse overflow pages without a copy per page. macOS
/// uses the caller's bounded page cache: mapping amplifies physical reads on
/// the full owner-scale integrity scan on the hosted runner.
/// Callers close or unmap the temporary window before serving requests.
pub const VALIDATION_MMAP_BYTES: i64 = if cfg!(target_os = "macos") {
    0
} else if cfg!(unix) {
    8_589_934_592
} else {
    0
};

/// Coalesce the filesystem reads of a complete startup integrity scan. This
/// is advisory only: SQLite still reads and validates the current database,
/// including WAL contents, and no validation result is cached.
pub fn advise_validation_scan(path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let Ok(file) = std::fs::File::open(path) else {
            return;
        };
        let Ok(metadata) = file.metadata() else {
            return;
        };
        // Darwin takes a signed 32-bit count per advice. Smaller contiguous
        // ranges avoid the overflow-page scan issuing tiny physical reads.
        const RANGE: u64 = 67_108_864;
        let mut offset = 0;
        while offset < metadata.len() {
            let count = RANGE.min(metadata.len() - offset);
            if rustix::fs::fcntl_rdadvise(&file, offset, count).is_err() {
                break;
            }
            offset += count;
        }
        // Close before SQLite opens: closing another descriptor must never
        // release SQLite's POSIX locks during validation.
    }
    #[cfg(not(target_os = "macos"))]
    let _ = path;
}

/// Open a file database with rusqlite's normal default flags.
pub fn open(path: impl AsRef<Path>) -> Result<Connection> {
    open_with_flags(path, OpenFlags::default())
}

/// Preserve the caller's flags; Windows uses SQLite's built-in long-path VFS.
/// Its locking, journaling and sync operations are the normal Windows ones.
pub fn open_with_flags(path: impl AsRef<Path>, flags: OpenFlags) -> Result<Connection> {
    #[cfg(windows)]
    {
        let path = extended_file_path(path.as_ref()).map_err(|error| {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
                Some(error.to_string()),
            )
        })?;
        rusqlite::Connection::open_with_flags_and_vfs(path, flags, "win32-longpath")
            .and_then(Connection::track)
    }
    #[cfg(not(windows))]
    {
        rusqlite::Connection::open_with_flags(path, flags).and_then(Connection::track)
    }
}

#[cfg(windows)]
fn extended_file_path(path: &Path) -> std::io::Result<std::path::PathBuf> {
    // Preserve SQLite's special names and URI handling. File callers need the
    // extended prefix as well as the larger VFS buffer; the host may not have
    // enabled long paths system-wide, and SQLite does not add this prefix.
    if path.as_os_str().is_empty()
        || path == Path::new(":memory:")
        || path.to_str().is_some_and(|name| name.starts_with("file:"))
    {
        return Ok(path.to_path_buf());
    }
    let Some(name) = path.file_name() else {
        return std::fs::canonicalize(path);
    };
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    Ok(std::fs::canonicalize(parent)?.join(name))
}

/// Sync committed WAL bytes and their directory entry without copying pages to
/// the main DB. Callers retain their own checkpoint and close policy.
pub fn sync_wal(connection: &rusqlite::Connection) -> std::io::Result<()> {
    let Some(path) = connection.path().filter(|path| !path.is_empty()) else {
        return Ok(());
    };
    let wal = std::path::PathBuf::from(format!("{path}-wal"));
    match crate::secure_fs::sync_path(&wal) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        result => result?,
    }
    if let Some(parent) = wal.parent() {
        crate::secure_fs::sync_directory(parent).unwrap_or(Ok(()))?;
    }
    Ok(())
}

/// Finish mapped WAL-index writeback while retaining the file descriptor for
/// the lifetime of every connection, so SQLite's process locks are preserved.
pub fn sync_wal_index(connection: &rusqlite::Connection) -> std::io::Result<()> {
    connection::sync_wal_index(connection)
}

/// Cross-process WAL deadman-lock evidence for E2E; never changes a lock.
/// Unsupported platforms return `None`, an unlocked index returns PID zero.
#[cfg(feature = "test-support")]
pub fn wal_index_lock_owner(path: &Path) -> std::io::Result<Option<u32>> {
    #[cfg(unix)]
    {
        use nix::{
            fcntl::{FcntlArg, fcntl},
            libc,
        };
        let file = crate::secure_fs::open_read_no_follow(path)?;
        let mut lock = libc::flock {
            l_start: 128,
            l_len: 1,
            l_pid: 0,
            l_type: libc::F_WRLCK as _,
            l_whence: i16::try_from(libc::SEEK_SET).map_err(std::io::Error::other)?,
        };
        fcntl(&file, FcntlArg::F_GETLK(&mut lock)).map_err(std::io::Error::from)?;
        Ok(Some(u32::try_from(lock.l_pid).unwrap_or(0)))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(None)
    }
}
