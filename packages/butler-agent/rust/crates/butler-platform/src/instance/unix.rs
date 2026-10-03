//! Host facts, kernel process identity and stop signals on Unix.

use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::process::Command;

use nix::errno::Errno;
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;

use super::{IdentityError, StopError, SystemTimeZone};

pub(super) fn host_name() -> io::Result<String> {
    let name = nix::unistd::gethostname().map_err(io::Error::from)?;
    Ok(name.to_string_lossy().into_owned())
}

pub(super) fn os_release() -> io::Result<String> {
    let system = nix::sys::utsname::uname().map_err(io::Error::from)?;
    Ok(system.release().to_string_lossy().into_owned())
}

pub(super) fn system_time_zone() -> io::Result<SystemTimeZone> {
    Ok(SystemTimeZone::File("/etc/localtime".into()))
}

pub(super) fn process_started_at_ms(pid: u32) -> Option<i64> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = std::str::from_utf8(&output.stdout).ok()?.trim();
    let converted = epoch_seconds_command(raw)?.output().ok()?;
    if !converted.status.success() {
        return None;
    }
    std::str::from_utf8(&converted.stdout)
        .ok()?
        .trim()
        .parse::<i64>()
        .ok()?
        .checked_mul(1000)
}

/// The `date` invocation that converts an `lstart` timestamp to epoch seconds.
#[cfg(target_os = "macos")]
fn epoch_seconds_command(lstart: &str) -> Option<Command> {
    let mut command = Command::new("date");
    command.args(["-j", "-f", "%a %b %e %T %Y", lstart, "+%s"]);
    Some(command)
}

#[cfg(target_os = "linux")]
fn epoch_seconds_command(lstart: &str) -> Option<Command> {
    let mut command = Command::new("date");
    command.args(["-d", lstart, "+%s"]);
    Some(command)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn epoch_seconds_command(_lstart: &str) -> Option<Command> {
    None
}

/// Whether a process has the id: `kill(pid, 0)` finds it, or finds it owned
/// by another user.
#[cfg(target_os = "macos")]
fn exists(pid: i32) -> Result<bool, IdentityError> {
    match kill(Pid::from_raw(pid), None) {
        Err(Errno::ESRCH) => Ok(false),
        Ok(()) | Err(Errno::EPERM) => Ok(true),
        Err(error) => Err(IdentityError::Probe(error.to_string())),
    }
}

#[cfg(target_os = "linux")]
pub(super) fn process_start(pid: u32) -> Result<Option<String>, IdentityError> {
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(IdentityError::Unavailable(Some(error))),
    };
    // The command name is parenthesized and may contain spaces; the fields
    // after it are space separated, the start time 20th among them.
    let tail = stat
        .rfind(')')
        .and_then(|index| stat.get(index + 1..))
        .ok_or(IdentityError::Unavailable(None))?;
    if tail.split_whitespace().next() == Some("Z") {
        return Ok(None);
    }
    let start_ticks = tail
        .split_whitespace()
        .nth(19)
        .ok_or(IdentityError::Unavailable(None))?;
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map_err(|error| IdentityError::Unavailable(Some(error)))?;
    Ok(Some(format!("linux:{}:{}", boot_id.trim(), start_ticks)))
}

#[cfg(target_os = "linux")]
pub(super) fn process_executable(pid: u32) -> Result<Option<String>, IdentityError> {
    match fs::read_link(format!("/proc/{pid}/exe")) {
        Ok(path) => Ok(Some(path.to_string_lossy().into_owned())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(IdentityError::Unavailable(Some(error))),
    }
}

#[cfg(target_os = "macos")]
pub(super) fn process_start(pid: u32) -> Result<Option<String>, IdentityError> {
    use libproc::bsd_info::BSDInfo;
    use libproc::proc_pid::pidinfo;

    let target = i32::try_from(pid).map_err(|_| IdentityError::Unavailable(None))?;
    let info = match pidinfo::<BSDInfo>(target, 0) {
        Ok(info) => info,
        Err(message) if libproc_missing(&message) => return Ok(None),
        Err(_) if !exists(target)? => return Ok(None),
        Err(_) => return Err(IdentityError::Unavailable(None)),
    };
    if info.pbi_pid != pid {
        return Err(IdentityError::Unavailable(None));
    }
    Ok(Some(format!(
        "macos:{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    )))
}

#[cfg(target_os = "macos")]
pub(super) fn process_executable(pid: u32) -> Result<Option<String>, IdentityError> {
    use libproc::proc_pid::pidpath;

    let target = i32::try_from(pid).map_err(|_| IdentityError::Unavailable(None))?;
    match pidpath(target) {
        Ok(path) => fs::canonicalize(path)
            .map(|path| Some(path.to_string_lossy().into_owned()))
            .map_err(|error| IdentityError::Unavailable(Some(error))),
        Err(message) if libproc_missing(&message) => Ok(None),
        Err(_) if !exists(target)? => Ok(None),
        Err(_) => Err(IdentityError::Unavailable(None)),
    }
}

/// Darwin excludes unreaped zombies from libproc but `kill(pid, 0)` still
/// sees them. Only ESRCH proves this exit; permission/probe errors stay errors.
#[cfg(target_os = "macos")]
fn libproc_missing(message: &str) -> bool {
    // libproc (pinned) reports `..., errno = <n>, message = ...`.
    message.contains(&format!(", errno = {}, ", Errno::ESRCH as i32))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(super) fn process_start(_pid: u32) -> Result<Option<String>, IdentityError> {
    Err(IdentityError::Unsupported)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(super) fn process_executable(_pid: u32) -> Result<Option<String>, IdentityError> {
    Err(IdentityError::Unsupported)
}

/// Whether two paths name the same file (device and inode).
pub(super) fn same_file(first: &str, second: &str) -> bool {
    match (fs::metadata(first), fs::metadata(second)) {
        (Ok(first), Ok(second)) => first.dev() == second.dev() && first.ino() == second.ino(),
        _ => false,
    }
}

pub(super) fn request_stop(pid: u32) -> Result<(), StopError> {
    signal(pid, Signal::SIGTERM)
}

pub(super) fn terminate(pid: u32, started: &str) -> Result<(), StopError> {
    target(pid)?;
    match process_start(pid) {
        Ok(Some(current)) if current == started => signal(pid, Signal::SIGKILL),
        Ok(_) => Err(StopError::Gone),
        Err(error) => Err(StopError::Identity(error)),
    }
}

/// The id as a single process: 0 and negative ids address process groups.
fn target(pid: u32) -> Result<Pid, StopError> {
    i32::try_from(pid)
        .ok()
        .filter(|pid| *pid > 0)
        .map(Pid::from_raw)
        .ok_or(StopError::InvalidPid(pid))
}

fn signal(pid: u32, signal: Signal) -> Result<(), StopError> {
    match kill(target(pid)?, signal) {
        Ok(()) => Ok(()),
        Err(Errno::ESRCH) => Err(StopError::Gone),
        Err(error) => Err(StopError::Delivery(error.to_string())),
    }
}
