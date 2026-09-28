//! macOS process identity through libproc.

use std::fs;

use libproc::bsd_info::BSDInfo;
use libproc::proc_pid::{pidinfo, pidpath};
use nix::errno::Errno;
use nix::sys::signal::kill;
use nix::unistd::Pid;

use super::IdentityError;

pub(super) fn process_start_identity(pid: u32) -> Result<Option<String>, IdentityError> {
    let pid = i32::try_from(pid).map_err(IdentityError::PidOutOfRange)?;
    let info = match pidinfo::<BSDInfo>(pid, 0) {
        Ok(info) => info,
        Err(_) if !process_is_alive(pid)? => return Ok(None),
        Err(_) => return Err(IdentityError::unavailable()),
    };
    let expected_pid = u32::try_from(pid).map_err(IdentityError::PidOutOfRange)?;
    if info.pbi_pid != expected_pid {
        return Err(IdentityError::unavailable());
    }
    Ok(Some(format!(
        "macos:{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    )))
}

pub(super) fn process_executable(pid: u32) -> Result<Option<String>, IdentityError> {
    let pid = i32::try_from(pid).map_err(IdentityError::PidOutOfRange)?;
    match pidpath(pid) {
        Ok(path) => fs::canonicalize(path)
            .map(|path| Some(path.to_string_lossy().into_owned()))
            .map_err(|source| IdentityError::Unavailable {
                source: Some(source),
            }),
        Err(_) if !process_is_alive(pid)? => Ok(None),
        Err(_) => Err(IdentityError::unavailable()),
    }
}

/// A process another user owns is alive too.
fn process_is_alive(pid: i32) -> Result<bool, IdentityError> {
    match kill(Pid::from_raw(pid), None) {
        Err(Errno::ESRCH) => Ok(false),
        Ok(()) | Err(Errno::EPERM) => Ok(true),
        Err(error) => Err(IdentityError::ProbeFailed(error.to_string())),
    }
}
