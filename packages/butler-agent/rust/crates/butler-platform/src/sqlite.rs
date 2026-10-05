//! File SQLite connections using the host's path-capable VFS.
//! Database schemas, flags, transactions and state remain with their owners.
use rusqlite::{Connection, OpenFlags, Result};
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
        Connection::open_with_flags_and_vfs(path, flags, "win32-longpath")
    }
    #[cfg(not(windows))]
    {
        Connection::open_with_flags(path, flags)
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
pub fn sync_wal(connection: &Connection) -> std::io::Result<()> {
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
