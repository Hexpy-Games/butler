//! One service instance per DATA folder: the exclusive instance lock, the host
//! name and the operating-system identity of a process.
//!
//! The lock is the kernel's advisory file lock (`flock` on macOS and Linux,
//! `LockFileEx` on Windows): it belongs to the open file and is released when
//! the lock is dropped or its process dies. Process identity combines the
//! start time and executable a pid had, so a recorded pid is never trusted
//! after the operating system reused it: macOS reads them through libproc,
//! Linux from `/proc` with the boot id. Windows identity is not implemented
//! yet and reports [`IdentityError::Unsupported`].

use std::fs::{File, TryLockError};
use std::io;
use std::num::TryFromIntError;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as identity;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as identity;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod unsupported;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
use unsupported as identity;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// An advisory lock on an open file, held until this value is dropped.
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

fn locked(result: Result<(), TryLockError>, file: File) -> Result<InstanceLock, LockError> {
    match result {
        Ok(()) => Ok(InstanceLock { file }),
        Err(TryLockError::WouldBlock) => Err(LockError::Busy),
        Err(TryLockError::Error(error)) => Err(LockError::Failed(error)),
    }
}

/// Why the identity of a process could not be read.
#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    /// The host did not report the identity of a running process.
    #[error("the process identity is unavailable")]
    Unavailable {
        /// The failed read, when one failed.
        #[source]
        source: Option<io::Error>,
    },
    /// The process id cannot name a process on this host.
    #[error("process id is outside the supported range")]
    PidOutOfRange(#[source] TryFromIntError),
    /// Probing whether the process exists failed; the value is the host's
    /// description of the failure.
    #[error("{0}")]
    ProbeFailed(String),
    /// This host cannot read process identities yet.
    #[error("process identity is unsupported on this host")]
    Unsupported,
}

impl IdentityError {
    #[cfg_attr(
        not(any(target_os = "linux", target_os = "macos")),
        expect(
            dead_code,
            reason = "only the macOS and Linux identities read the host"
        )
    )]
    fn unavailable() -> Self {
        Self::Unavailable { source: None }
    }
}

/// The start identity of process `pid` (`macos:<sec>:<usec>` or
/// `linux:<boot id>:<start ticks>`), or `None` when no such process exists.
pub fn process_start_identity(pid: u32) -> Result<Option<String>, IdentityError> {
    identity::process_start_identity(pid)
}

/// The canonical executable path of process `pid`, or `None` when no such
/// process exists.
pub fn process_executable(pid: u32) -> Result<Option<String>, IdentityError> {
    identity::process_executable(pid)
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
