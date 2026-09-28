//! Host facts, process identity and stopping another process are not
//! implemented on Windows yet. The Windows stage reads a process's start
//! time and executable from a process handle, and terminates through the
//! same handle after comparing its start time.

use std::io;

use super::{IdentityError, StopError};

pub(super) fn host_name() -> io::Result<String> {
    Err(unsupported("the host name"))
}

pub(super) fn os_release() -> io::Result<String> {
    Err(unsupported("the operating system release"))
}

fn unsupported(what: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        format!("{what} is unsupported on this host"),
    )
}

pub(super) fn process_started_at_ms(_pid: u32) -> Option<i64> {
    None
}

pub(super) fn process_start(_pid: u32) -> Result<Option<String>, IdentityError> {
    Err(IdentityError::Unsupported)
}

pub(super) fn process_executable(_pid: u32) -> Result<Option<String>, IdentityError> {
    Err(IdentityError::Unsupported)
}

/// Without file ids for executables yet, only equal paths match.
pub(super) fn same_file(_first: &str, _second: &str) -> bool {
    false
}

/// Windows has no stop request between processes; controllers use the
/// service's control endpoint.
pub(super) fn request_stop(_pid: u32) -> Result<(), StopError> {
    Err(StopError::Unsupported)
}

pub(super) fn terminate(_pid: u32, _started: &str) -> Result<(), StopError> {
    Err(StopError::Unsupported)
}
