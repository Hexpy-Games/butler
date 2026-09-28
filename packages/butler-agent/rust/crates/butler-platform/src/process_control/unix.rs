//! Process groups and POSIX signals.

use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, ExitStatus};

use nix::errno::Errno;
use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::Pid;

use super::{ExitSignal, GroupSignal, Liveness, SignalError};

pub(super) const CONTAINS_PROCESS_TREES: bool = true;

pub(super) const BASELINE_ENVIRONMENT: &[&str] =
    &["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

pub(super) fn isolate_group(command: &mut Command) -> Option<&mut Command> {
    Some(command.process_group(0))
}

pub(super) fn signal_group(pid: u32, signal: GroupSignal) -> Result<(), SignalError> {
    // 0 addresses the caller's own group; negative ids are not groups.
    let group = i32::try_from(pid)
        .ok()
        .filter(|group| *group > 0)
        .ok_or(SignalError::InvalidPid(pid))?;
    let signal = match signal {
        GroupSignal::Kill => Signal::SIGKILL,
        GroupSignal::Terminate => Signal::SIGTERM,
    };
    match killpg(Pid::from_raw(group), signal) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        // Darwin reports EPERM for a group whose remaining members are all
        // zombies awaiting their parent; there is nothing left to signal.
        Err(Errno::EPERM) if group_has_only_zombies(pid) => Ok(()),
        Err(error) => Err(SignalError::Delivery {
            signal: signal.as_str(),
            detail: error.to_string(),
        }),
    }
}

/// Darwin keeps zombies out of `proc_pidinfo` (it fails with ESRCH) while
/// `kill(pid, 0)` and the group listing still see them, so a listed member is
/// a zombie exactly when it exists but has no BSD process info.
#[cfg(target_os = "macos")]
fn group_has_only_zombies(group: u32) -> bool {
    use libproc::bsd_info::BSDInfo;
    use libproc::proc_pid::pidinfo;
    use libproc::processes::{ProcFilter, pids_by_type};

    // An empty group lists as 0 bytes, which libproc reads as failure when
    // errno still holds the EPERM from `killpg`; clear it first.
    Errno::clear();
    let Ok(members) = pids_by_type(ProcFilter::ByProgramGroup { pgrpid: group }) else {
        return false;
    };
    members.into_iter().filter(|pid| *pid != 0).all(|pid| {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        match pidinfo::<BSDInfo>(pid, 0) {
            // libproc (pinned) reports `..., errno = <n>, message = ...`.
            Err(message) if message.contains(&format!(", errno = {}, ", Errno::ESRCH as i32)) => {
                matches!(kill(Pid::from_raw(pid), None), Ok(()) | Err(Errno::ESRCH))
            }
            _ => false,
        }
    })
}

#[cfg(not(target_os = "macos"))]
fn group_has_only_zombies(_group: u32) -> bool {
    false
}

pub(super) fn terminating_signal(status: ExitStatus) -> Option<ExitSignal> {
    status.signal().map(|number| match number {
        nix::libc::SIGINT => ExitSignal::Interrupt,
        nix::libc::SIGKILL => ExitSignal::Kill,
        nix::libc::SIGTERM => ExitSignal::Terminate,
        other => ExitSignal::Other(other),
    })
}

pub(super) fn liveness(pid: u32) -> Liveness {
    // A pid outside 1..=i32::MAX names no single process (0 and negative
    // values address process groups).
    let Some(pid) = i32::try_from(pid).ok().filter(|pid| *pid > 0) else {
        return Liveness::Gone;
    };
    match kill(Pid::from_raw(pid), None) {
        Ok(()) => Liveness::Running,
        Err(Errno::EPERM) => Liveness::OtherOwner,
        Err(Errno::ESRCH) => Liveness::Gone,
        Err(_) => Liveness::Unknown,
    }
}
