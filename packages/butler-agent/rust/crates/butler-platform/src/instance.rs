//! One service instance per DATA folder: the exclusive instance lock and the
//! facts that identify this host and a process start.
//!
//! The lock is the host's whole-file lock on an open file: `flock` on macOS
//! and Linux, which is advisory (only other `flock` callers are excluded),
//! and `LockFileEx` over the whole file on Windows, which is mandatory (other
//! handles cannot read or write the file while it is held).
//!
//! Compared with `nix::fcntl::Flock`, which the agent uses today:
//! - On macOS and Linux both lock the open file description, so a
//!   `try_clone` of [`InstanceLock::file`] (or a descriptor a child process
//!   inherits) shares the lock, and a second `open` of the same path does
//!   not.
//! - Both unlock explicitly when dropped ([`InstanceLock`] calls
//!   `File::unlock`), so a duplicated descriptor that outlives the lock does
//!   not keep holding it.
//! - A failed attempt consumes the file here; `Flock::lock` hands it back.
//!   Callers reopen the path to retry.

use std::fs::{File, TryLockError};
use std::io;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// A lock on an open file, held until this value is dropped.
#[derive(Debug)]
pub struct InstanceLock {
    file: File,
}

/// Why an [`InstanceLock`] was not taken.
#[derive(Debug, thiserror::Error)]
pub enum LockError {
    /// Another open file holds a conflicting lock.
    #[error("the lock is held by another owner")]
    Busy,
    /// The host failed to lock the file.
    #[error(transparent)]
    Failed(io::Error),
}

impl InstanceLock {
    /// Takes the exclusive lock of `file` without waiting.
    pub fn try_exclusive(file: File) -> Result<Self, LockError> {
        locked(file.try_lock(), file)
    }

    /// Takes a shared lock of `file` without waiting; it conflicts only with
    /// an exclusive lock.
    pub fn try_shared(file: File) -> Result<Self, LockError> {
        locked(file.try_lock_shared(), file)
    }

    /// The locked file.
    pub fn file(&self) -> &File {
        &self.file
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        // Closing the file releases the lock too; unlocking first also
        // releases it while a duplicated descriptor stays open.
        let _ = self.file.unlock();
    }
}

fn locked(result: Result<(), TryLockError>, file: File) -> Result<InstanceLock, LockError> {
    match result {
        Ok(()) => Ok(InstanceLock { file }),
        Err(TryLockError::WouldBlock) => Err(LockError::Busy),
        Err(TryLockError::Error(error)) => Err(LockError::Failed(error)),
    }
}

/// The host name, lossily decoded.
pub fn host_name() -> io::Result<String> {
    sys::host_name()
}

/// When process `pid` started, in epoch milliseconds at whole-second
/// resolution, as `ps -o lstart=` reports it; `None` when it cannot be read.
///
/// Project Ledger mutation claims persist this value and compare it again, so
/// it keeps the exact resolution and source it always had.
pub fn process_started_at_ms(pid: u32) -> Option<i64> {
    sys::process_started_at_ms(pid)
}
