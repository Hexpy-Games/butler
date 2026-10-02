//! File SQLite connections using the host's path-capable VFS.
//! Database schemas, flags, transactions and state remain with their owners.
use rusqlite::{Connection, OpenFlags, Result};
use std::path::Path;

/// Open a file database with rusqlite's normal default flags.
pub fn open(path: impl AsRef<Path>) -> Result<Connection> {
    open_with_flags(path, OpenFlags::default())
}

/// Preserve the caller's flags; Windows uses SQLite's built-in long-path VFS.
/// Its locking, journaling and sync operations are the normal Windows ones.
pub fn open_with_flags(path: impl AsRef<Path>, flags: OpenFlags) -> Result<Connection> {
    #[cfg(windows)]
    {
        Connection::open_with_flags_and_vfs(path, flags, "win32-longpath")
    }
    #[cfg(not(windows))]
    {
        Connection::open_with_flags(path, flags)
    }
}
