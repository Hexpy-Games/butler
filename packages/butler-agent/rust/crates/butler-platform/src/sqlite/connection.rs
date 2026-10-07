//! Retain WAL-index descriptors until SQLite has closed every local connection.
use std::ops::{Deref, DerefMut};

/// A SQLite connection with the same SQLite operations and close policy.
/// The retained index descriptor must be dropped after the SQLite connection.
pub struct Connection {
    raw: rusqlite::Connection,
    #[cfg(target_os = "macos")]
    index: IndexOwner,
}

impl Connection {
    /// Open an isolated SQLite memory database; it has no mapped index.
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        #[cfg(target_os = "macos")]
        return rusqlite::Connection::open_in_memory().and_then(Self::track);
        #[cfg(not(target_os = "macos"))]
        rusqlite::Connection::open_in_memory().map(Self::track)
    }

    #[cfg(target_os = "macos")]
    pub(super) fn track(raw: rusqlite::Connection) -> rusqlite::Result<Self> {
        let index = IndexOwner::new(&raw).map_err(|error| sql_error(&error))?;
        Ok(Self { raw, index })
    }
    #[cfg(not(target_os = "macos"))]
    pub(super) fn track(raw: rusqlite::Connection) -> Self {
        Self { raw }
    }

    /// Failed SQLite close retains the handle; writeback errors after close do not.
    pub fn close(self) -> Result<(), (Option<Box<Self>>, rusqlite::Error)> {
        #[cfg(target_os = "macos")]
        if let Err(error) = self.index.sync() {
            return Err((Some(Box::new(self)), sql_error(&error)));
        }
        let Self {
            raw,
            #[cfg(target_os = "macos")]
            index,
        } = self;
        match raw.close() {
            Ok(()) => {
                // SQLite has released this connection's read marks; other local
                // connections retain the descriptor through their shared owner.
                #[cfg(target_os = "macos")]
                return index.finish().map_err(|error| (None, sql_error(&error)));
                #[cfg(not(target_os = "macos"))]
                Ok(())
            }
            Err((raw, error)) => Err((
                Some(Box::new(Self {
                    raw,
                    #[cfg(target_os = "macos")]
                    index,
                })),
                error,
            )),
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

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
pub(super) fn sync_wal_index(connection: &rusqlite::Connection) -> std::io::Result<()> {
    index::sync(connection)
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Connection").finish_non_exhaustive()
    }
}
