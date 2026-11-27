//! Owner-only local socket listeners for remote service mode.

use std::{io, path::Path};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

pub use sys::{LocalListener, LocalStream};

/// The longest socket path [`bind`] accepts, in bytes; `None` where any
/// path works.
pub const PATH_LIMIT: Option<usize> = sys::PATH_LIMIT;

/// Bind a socket in a private directory, replacing only an existing socket.
pub fn bind(path: &Path) -> io::Result<LocalListener> {
    sys::bind(path)
}

/// Accept the next local socket connection.
pub async fn accept(listener: &LocalListener) -> io::Result<LocalStream> {
    sys::accept(listener).await
}

/// Connect to a local socket.
pub async fn connect(path: &Path) -> io::Result<LocalStream> {
    sys::connect(path).await
}

/// Whether only the owner has access to a socket or its directory.
pub fn owner_only(path: &Path) -> io::Result<bool> {
    sys::owner_only(path)
}
