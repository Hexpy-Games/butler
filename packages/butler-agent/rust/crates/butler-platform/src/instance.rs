//! One service instance per DATA folder: the exclusive instance lock, the
//! facts that identify this host and a process start, and stopping another
//! instance once its identity is checked.
//!
//! The lock is the host's whole-file lock on an open file: `flock` on macOS
//! and Linux, which is advisory (only other `flock` callers are excluded),
//! and `LockFileEx` over the whole file on Windows, which is mandatory (other
//! handles cannot read or write the file while it is held).
//!
//! Compared with `nix::fcntl::Flock`, which the agent used before:
//! - On macOS and Linux both lock the open file description, so a
//!   `try_clone` of [`InstanceLock::file`] (or a descriptor a child process
//!   inherits) shares the lock, and a second `open` of the same path does
//!   not.
//! - Both unlock explicitly when dropped ([`InstanceLock`] calls
//!   `File::unlock`), so a duplicated descriptor that outlives the lock does
//!   not keep holding it. Closing the file (or the holder dying) releases it
//!   too.
//! - A failed attempt consumes the file here; `Flock::lock` hands it back.
//!   Callers reopen the path to retry.
//!
//! # Stopping another instance
//!
//! A controller stops the instance that owns DATA in two steps, after it has
//! checked the instance's record, lock and [`process_start`] identity and
//! announced the stop in the DATA stop intent:
//!
//! 1. [`request_stop`] asks the process to stop. On Unix that is SIGTERM,
//!    which the service receives through
//!    `process_control::shutdown_requests` and handles like any requested
//!    stop. Windows has no request one process can send another: a detached
//!    service has no console for a control event, so [`request_stop`]
//!    reports [`StopError::Unsupported`] there. The controller instead sends
//!    the `service_stop` command to the instance's token-protected control
//!    endpoint, which requests the same stop inside the service, or, for an
//!    instance that has not published its endpoint yet, writes the DATA
//!    shutdown flag (`locks/butler-shutdown`) that the starting service
//!    checks.
//! 2. When the grace period passes, [`terminate`] ends the process, only
//!    while it is still the process that started at the recorded time:
//!    SIGKILL on Unix; on Windows `TerminateProcess` while a handle to the process,
//!    whose start time was compared through it, stays open, so the id cannot
//!    name another process in between.

mod locale;
pub use locale::system_locale;

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

    /// Takes the exclusive lock of `file`, waiting while another owner holds
    /// a conflicting one. For short critical sections, such as rewriting a
    /// record, whose other holders never wait on this caller.
    pub fn exclusive(file: File) -> io::Result<Self> {
        file.lock()?;
        Ok(Self { file })
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

/// The operating system's release, lossily decoded: `uname -r` on Unix,
/// `10.0.<build>` on Windows (as Node's `os.release()`).
pub fn os_release() -> io::Result<String> {
    sys::os_release()
}

/// Where the system's time zone rules come from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SystemTimeZone {
    /// A compiled TZif file: `/etc/localtime` on Unix.
    File(std::path::PathBuf),
    /// An IANA zone name, such as `Asia/Seoul`: Windows names its zones
    /// differently, and the host maps its zone to the IANA name.
    Named(String),
}

/// The system's time zone (see [`SystemTimeZone`]); an error when Windows
/// could not name it.
pub fn system_time_zone() -> io::Result<SystemTimeZone> {
    sys::system_time_zone()
}

/// When process `pid` started, in epoch milliseconds at whole-second
/// resolution, as `ps -o lstart=` reports it; `None` when it cannot be read.
///
/// Project Ledger mutation claims persist this value and compare it again, so
/// it keeps the exact resolution and source it always had.
pub fn process_started_at_ms(pid: u32) -> Option<i64> {
    sys::process_started_at_ms(pid)
}

/// Why the identity of a process could not be read.
#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    /// The process exists, but the host did not report its identity.
    #[error("the process identity is unavailable")]
    Unavailable(#[source] Option<io::Error>),
    /// Whether the process exists could not be told; the host's reason.
    #[error("{0}")]
    Probe(String),
    /// This host cannot identify processes.
    #[error("process identity is unsupported on this host")]
    Unsupported,
}

/// When process `pid` started, as text that differs for every process the id
/// ever names on this host: `macos:<seconds>:<microseconds>` (the kernel's
/// start time), `linux:<boot id>:<start ticks>` or `windows:<seconds>` (the
/// process table's start time; a process id is not reused while a handle to
/// the process is open, see [`terminate`]). `None` when no process has the
/// id. Instance records persist it, so the format is pinned.
pub fn process_start(pid: u32) -> Result<Option<String>, IdentityError> {
    sys::process_start(pid)
}

/// The executable process `pid` runs: canonical on macOS, as
/// `/proc/<pid>/exe` reads on Linux, as the process table reports it on
/// Windows (without a needless `\\?\` prefix). `None` when no process has
/// the id.
pub fn process_executable(pid: u32) -> Result<Option<String>, IdentityError> {
    sys::process_executable(pid)?
        .map(|path| {
            crate::process_names::canonical_identity(path.into())
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| IdentityError::Unavailable(Some(error)))
        })
        .transpose()
}

/// Whether `observed` (a [`process_executable`] value) is the executable
/// `expected` names: the same path, or another name of the same file. macOS
/// reports a file with several hard links under whichever name was looked up
/// last, so the files are compared (device and inode), not their names.
pub fn same_executable(expected: &str, observed: &str) -> bool {
    observed == expected || sys::same_file(expected, observed)
}

/// Why a stop did not reach a process.
#[derive(Debug, thiserror::Error)]
pub enum StopError {
    /// The id names no single process: 0 (a process group on Unix) or an id
    /// outside the host's range.
    #[error("process id {0} names no single process")]
    InvalidPid(u32),
    /// No process has the id any more; for [`terminate`], also when the
    /// process that has it started at another time (the id was reused).
    #[error("the process has exited")]
    Gone,
    /// [`terminate`] could not read the process's identity.
    #[error(transparent)]
    Identity(IdentityError),
    /// The host refused to deliver the stop; the host's reason.
    #[error("{0}")]
    Delivery(String),
    /// This host cannot stop another process this way (see the module
    /// documentation for the route Windows takes instead).
    #[error("stopping another process this way is unsupported on this host")]
    Unsupported,
}

/// Asks process `pid` to stop: SIGTERM on Unix. Windows reports
/// [`StopError::Unsupported`]: its controllers stop a service through the
/// service's control endpoint (see the module documentation).
pub fn request_stop(pid: u32) -> Result<(), StopError> {
    sys::request_stop(pid)
}

/// Ends process `pid` at once, only while it is still the process that
/// started at `started` (a [`process_start`] value): SIGKILL on Unix, right
/// after the start is read again. [`StopError::Gone`] when it has exited or
/// its id names another process now. Windows ends it with `TerminateProcess`
/// while a handle opened to read its start keeps the id from being reused.
pub fn terminate(pid: u32, started: &str) -> Result<(), StopError> {
    sys::terminate(pid, started)
}
