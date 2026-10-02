//! Process groups, POSIX signals and the stdin lease.

use std::fs::File;
use std::io::{self, Read};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, ExitStatus};

use nix::errno::Errno;
use nix::fcntl::{FcntlArg, OFlag, fcntl};
use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::Pid;
use tokio::io::unix::AsyncFd;
use tokio::signal::unix::{SignalKind, signal};

use super::{ExitSignal, GroupSignal, Liveness, ShutdownRequest, SignalError};

pub(super) const CONTAINS_PROCESS_TREES: bool = true;

pub(super) const SIGNALS: bool = true;

pub(super) const SYSTEM_ENVIRONMENT: &[&str] = &[];

pub(super) const BASELINE_ENVIRONMENT: &[&str] =
    &["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

pub(super) fn isolate_group(command: &mut Command) -> Option<&mut Command> {
    Some(command.process_group(0))
}

/// The process group [`isolate_group`] made contains the command already.
pub(super) fn contain_tokio(_child: &tokio::process::Child) -> io::Result<()> {
    Ok(())
}

pub(super) fn contain_std(_child: &std::process::Child) -> io::Result<()> {
    Ok(())
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
    target_liveness(pid)
}

pub(super) fn target_liveness(target: i32) -> Liveness {
    match kill(Pid::from_raw(target), None) {
        Ok(()) => Liveness::Running,
        Err(Errno::EPERM) => Liveness::OtherOwner,
        Err(Errno::ESRCH) => Liveness::Gone,
        Err(_) => Liveness::Unknown,
    }
}

pub(super) fn hide_console(command: &mut Command) -> &mut Command {
    command
}

pub(super) fn detach(command: &mut Command) -> &mut Command {
    command.process_group(0)
}

/// SIGINT and SIGTERM, in that order; for a session, also SIGHUP and SIGPIPE.
#[derive(Debug)]
pub(super) struct ShutdownRequests {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
    hangup: Option<tokio::signal::unix::Signal>,
    pipe: Option<tokio::signal::unix::Signal>,
}

pub(super) fn shutdown_requests() -> io::Result<ShutdownRequests> {
    Ok(ShutdownRequests {
        interrupt: signal(SignalKind::interrupt())?,
        terminate: signal(SignalKind::terminate())?,
        hangup: None,
        pipe: None,
    })
}

pub(super) fn session_shutdown_requests() -> io::Result<ShutdownRequests> {
    Ok(ShutdownRequests {
        hangup: Some(signal(SignalKind::hangup())?),
        pipe: Some(signal(SignalKind::pipe())?),
        ..shutdown_requests()?
    })
}

/// The next delivery of an optional signal; never without one.
async fn next(signal: &mut Option<tokio::signal::unix::Signal>) {
    match signal {
        Some(signal) => {
            signal.recv().await;
        }
        None => std::future::pending().await,
    }
}

impl ShutdownRequests {
    pub(super) async fn recv(&mut self) -> ShutdownRequest {
        tokio::select! {
            _ = self.interrupt.recv() => ShutdownRequest::Interrupt,
            _ = self.terminate.recv() => ShutdownRequest::Terminate,
            () = next(&mut self.hangup) => ShutdownRequest::Terminate,
            () = next(&mut self.pipe) => ShutdownRequest::Terminate,
        }
    }
}

/// A non-blocking duplicate of stdin on the Tokio reactor, so waiting for
/// its end never occupies a thread and never blocks the runtime's shutdown.
#[derive(Debug)]
pub(super) struct StdinLease {
    input: AsyncFd<File>,
}

impl StdinLease {
    pub(super) fn capture() -> io::Result<Self> {
        let descriptor = nix::unistd::dup(std::io::stdin()).map_err(io::Error::from)?;
        let file = File::from(descriptor);
        let flags = fcntl(&file, FcntlArg::F_GETFL)
            .map(OFlag::from_bits_truncate)
            .map_err(io::Error::from)?;
        fcntl(&file, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK)).map_err(io::Error::from)?;
        Ok(Self {
            input: AsyncFd::new(file)?,
        })
    }

    pub(super) async fn closed(&self) -> io::Result<()> {
        let mut byte = [0_u8; 1];
        loop {
            let mut readable = self.input.readable().await?;
            match readable.try_io(|input| {
                let mut file = input.get_ref();
                file.read(&mut byte)
            }) {
                Ok(Ok(0)) => return Ok(()),
                Ok(Ok(_)) | Err(_) => {}
                Ok(Err(error)) => return Err(error),
            }
        }
    }
}
