//! OS process identity used to validate service records before signaling.

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::fs;
#[cfg(target_os = "linux")]
use std::io;

use nix::errno::Errno;
use nix::sys::signal::kill;
use nix::unistd::Pid;

pub(crate) fn executable_matches(expected: &str, observed: &str) -> bool {
    observed == expected
}

pub(crate) fn process_is_alive(pid: i32) -> Result<bool, String> {
    match kill(Pid::from_raw(pid), None) {
        Err(Errno::ESRCH) => Ok(false),
        Ok(()) | Err(Errno::EPERM) => Ok(true),
        Err(error) => Err(format!("native_service_process_probe_failed: {error}")),
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn process_start_identity(pid: u32) -> Result<Option<String>, String> {
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("native_service_process_identity_unavailable".into()),
    };
    let tail = stat
        .rfind(')')
        .and_then(|index| stat.get(index + 1..))
        .ok_or_else(|| "native_service_process_identity_unavailable".to_owned())?;
    let start_ticks = tail
        .split_whitespace()
        .nth(19)
        .ok_or_else(|| "native_service_process_identity_unavailable".to_owned())?;
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map_err(|_| "native_service_process_identity_unavailable".to_owned())?;
    Ok(Some(format!("linux:{}:{}", boot_id.trim(), start_ticks)))
}

#[cfg(target_os = "linux")]
pub(crate) fn process_executable(pid: u32) -> Result<Option<String>, String> {
    match fs::read_link(format!("/proc/{pid}/exe")) {
        Ok(path) => Ok(Some(path.to_string_lossy().into_owned())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("native_service_process_executable_unavailable".into()),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn process_start_identity(pid: u32) -> Result<Option<String>, String> {
    use libproc::bsd_info::BSDInfo;
    use libproc::proc_pid::pidinfo;

    let pid =
        i32::try_from(pid).map_err(|_| "native_service_process_identity_unavailable".to_owned())?;
    let info = match pidinfo::<BSDInfo>(pid, 0) {
        Ok(info) => info,
        Err(_) if !process_is_alive(pid)? => return Ok(None),
        Err(_) => return Err("native_service_process_identity_unavailable".into()),
    };
    let expected_pid =
        u32::try_from(pid).map_err(|_| "native_service_process_identity_unavailable".to_owned())?;
    if info.pbi_pid != expected_pid {
        return Err("native_service_process_identity_unavailable".into());
    }
    Ok(Some(format!(
        "macos:{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    )))
}

#[cfg(target_os = "macos")]
pub(crate) fn process_executable(pid: u32) -> Result<Option<String>, String> {
    use libproc::proc_pid::pidpath;

    let pid = i32::try_from(pid)
        .map_err(|_| "native_service_process_executable_unavailable".to_owned())?;
    match pidpath(pid) {
        Ok(path) => fs::canonicalize(path)
            .map(|path| Some(path.to_string_lossy().into_owned()))
            .map_err(|_| "native_service_process_executable_unavailable".into()),
        Err(_) if !process_is_alive(pid)? => Ok(None),
        Err(_) => Err("native_service_process_executable_unavailable".into()),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn process_start_identity(_pid: u32) -> Result<Option<String>, String> {
    Err("native_service_process_identity_unsupported".into())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn process_executable(_pid: u32) -> Result<Option<String>, String> {
    Err("native_service_process_identity_unsupported".into())
}

#[cfg(test)]
mod tests;
