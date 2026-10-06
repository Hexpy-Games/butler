//! Retain WAL-index descriptors until SQLite has closed every local connection.
use std::ops::{Deref, DerefMut};

/// A SQLite connection with the same SQLite operations and close policy.
/// The retained index descriptor must be dropped after the SQLite connection.
pub struct Connection {
    raw: rusqlite::Connection,
    index: IndexOwner,
}

impl Connection {
    /// Open an isolated SQLite memory database; it has no mapped index.
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        rusqlite::Connection::open_in_memory().and_then(Self::track)
    }

    pub(super) fn track(raw: rusqlite::Connection) -> rusqlite::Result<Self> {
        let index = IndexOwner::new(&raw).map_err(|error| sql_error(&error))?;
        Ok(Self { raw, index })
    }

    /// Failed SQLite close retains the handle; writeback errors after close do not.
    pub fn close(self) -> Result<(), (Option<Box<Self>>, rusqlite::Error)> {
        if let Err(error) = self.index.sync() {
            return Err((Some(Box::new(self)), sql_error(&error)));
        }
        let Self { raw, index } = self;
        match raw.close() {
            Ok(()) => {
                // SQLite has released this connection's read marks; other local
                // connections retain the descriptor through their shared owner.
                index.sync().map_err(|error| (None, sql_error(&error)))
            }
            Err((raw, error)) => Err((Some(Box::new(Self { raw, index })), error)),
        }
    }
}

impl Deref for Connection {
    type Target = rusqlite::Connection;
    fn deref(&self) -> &Self::Target {
        &self.raw
    }
}
impl DerefMut for Connection {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.raw
    }
}

fn sql_error(error: &std::io::Error) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR_FSYNC),
        Some(error.to_string()),
    )
}

#[cfg(target_os = "macos")]
mod index;
#[cfg(target_os = "macos")]
use index::IndexOwner;

#[cfg(not(target_os = "macos"))]
struct IndexOwner;
#[cfg(not(target_os = "macos"))]
impl IndexOwner {
    fn new(_: &rusqlite::Connection) -> std::io::Result<Self> {
        Ok(Self)
    }
    fn sync(&self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(super) fn sync_wal_index(connection: &rusqlite::Connection) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    return index::sync(connection);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = connection;
        Ok(())
    }
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Connection").finish_non_exhaustive()
    }
}
