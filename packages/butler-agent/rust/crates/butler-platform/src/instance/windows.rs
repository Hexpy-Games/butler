//! Host facts, process identity and ending an identified process on Windows.
//!
//! A process's identity is its start time (whole seconds, as the process
//! table reports it) read from a handle to it; the handle stays open while
//! [`terminate`] compares that start and ends the process, so the id cannot
//! name another process in between (see `process_table`). A stop request
//! has no Windows equivalent: controllers send the service its
//! `service_stop` control command instead.

use std::fs;
use std::io;

use super::{IdentityError, StopError, SystemTimeZone};
use crate::process_table::{self, ProcessView};

pub(super) fn host_name() -> io::Result<String> {
    process_table::host_name()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| io::Error::other("the host name is unavailable"))
}

/// `10.0.<build>`, as Node's `os.release()` reports Windows 10 and 11 (both
/// are NT 10.0).
pub(super) fn os_release() -> io::Result<String> {
    process_table::build_number()
        .filter(|build| !build.is_empty())
        .map(|build| format!("10.0.{build}"))
        .ok_or_else(|| io::Error::other("the Windows build number is unavailable"))
}

/// The IANA name Windows maps its current zone to.
pub(super) fn system_time_zone() -> io::Result<SystemTimeZone> {
    iana_time_zone::get_timezone()
        .map(SystemTimeZone::Named)
        .map_err(io::Error::other)
}

pub(super) fn process_started_at_ms(pid: u32) -> Option<i64> {
    let started = ProcessView::read(pid).ok()??.started_at_seconds().ok()?;
    i64::try_from(started)
        .ok()
        .filter(|seconds| *seconds > 0)?
        .checked_mul(1000)
}

pub(super) fn process_start(pid: u32) -> Result<Option<String>, IdentityError> {
    let Some(view) = read(pid)? else {
        return Ok(None);
    };
    start_of(&view).map(Some)
}

/// `windows:<seconds>`, or unavailable for a process this user may not open.
fn start_of(view: &ProcessView) -> Result<String, IdentityError> {
    view.started_at_seconds()
        .map(|seconds| format!("windows:{seconds}"))
        .map_err(unavailable)
}

pub(super) fn process_executable(pid: u32) -> Result<Option<String>, IdentityError> {
    let Some(view) = read(pid)? else {
        return Ok(None);
    };
    view.executable()
        .map(|path| path.map(|path| path.to_string_lossy().into_owned()))
        .map_err(unavailable)
}

/// The process with id `pid`; the idle process (0) is no process of ours.
fn read(pid: u32) -> Result<Option<ProcessView>, IdentityError> {
    if pid == 0 {
        return Ok(None);
    }
    ProcessView::read(pid).map_err(unavailable)
}

fn unavailable(error: io::Error) -> IdentityError {
    IdentityError::Unavailable(Some(error))
}

/// Both paths resolve to the same file: Windows paths differ in case, in
/// the `\\?\` prefix and in 8.3 short names, which resolving removes.
pub(super) fn same_file(first: &str, second: &str) -> bool {
    match (fs::canonicalize(first), fs::canonicalize(second)) {
        (Ok(first), Ok(second)) => first == second,
        _ => false,
    }
}

/// Windows has no stop request between processes; controllers use the
/// service's control endpoint.
pub(super) fn request_stop(_pid: u32) -> Result<(), StopError> {
    Err(StopError::Unsupported)
}

pub(super) fn terminate(pid: u32, started: &str) -> Result<(), StopError> {
    if pid == 0 || i32::try_from(pid).is_err() {
        return Err(StopError::InvalidPid(pid));
    }
    let Some(view) = read(pid).map_err(StopError::Identity)? else {
        return Err(StopError::Gone);
    };
    match start_of(&view) {
        Ok(current) if current == started => {}
        Ok(_) => return Err(StopError::Gone),
        Err(error) => return Err(StopError::Identity(error)),
    }
    match view.kill() {
        Ok(true) => Ok(()),
        Ok(false) => Err(StopError::Gone),
        Err(error) => Err(StopError::Identity(unavailable(error))),
    }
}
