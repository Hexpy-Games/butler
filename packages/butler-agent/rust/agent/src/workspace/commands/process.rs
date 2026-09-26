use std::future::Future;
use std::io;
use std::pin::Pin;
use std::process::ExitStatus;
use std::time::Duration;

use tokio::fs::File;
use tokio::io::AsyncWrite;
use tokio::process::{Child, Command};

use super::CommandError;

pub(super) const TERMINATION_GRACE: Duration = Duration::from_millis(500);
pub(super) const FORCE_SETTLEMENT_GRACE: Duration = Duration::from_millis(500);

pub(crate) type ProcessFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub(crate) type CaptureSink = Box<dyn AsyncWrite + Send + Unpin>;

/// Operating-system boundary of the command owner: spawning, process-group
/// signals, reaping and the spool writer that receives captured output.
///
/// Every method defaults to the real operating-system behavior, which is what
/// [`SystemProcesses`] uses. Alternative hosts model conditions a real process
/// cannot be made to produce on demand, such as a child that is not reaped
/// within the settlement grace.
pub(crate) trait ProcessHost: Send + Sync + 'static {
    fn spawn<'a>(&'a self, command: &'a mut Command) -> ProcessFuture<'a, io::Result<Child>> {
        Box::pin(async move { command.spawn() })
    }

    /// Signals the process group led by `pid` (SIGTERM, or SIGKILL when
    /// `force`). A group that no longer exists is already terminated.
    fn signal_group(&self, pid: u32, force: bool) -> Result<(), CommandError> {
        signal_pid(pid, force)
    }

    fn wait<'a>(&'a self, child: &'a mut Child) -> ProcessFuture<'a, io::Result<ExitStatus>> {
        Box::pin(child.wait())
    }

    fn try_wait(&self, child: &mut Child) -> io::Result<Option<ExitStatus>> {
        child.try_wait()
    }

    fn capture_sink(&self, file: File) -> CaptureSink {
        Box::new(file)
    }
}

pub(crate) struct SystemProcesses;

impl ProcessHost for SystemProcesses {}

#[cfg(unix)]
pub(super) fn signal_pid(pid: u32, force: bool) -> Result<(), CommandError> {
    use nix::errno::Errno;
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;

    let group = i32::try_from(pid).map_err(|_| {
        CommandError::new(
            "command_termination_failed",
            "The child process ID is outside the supported signal range",
        )
    })?;
    let signal = if force {
        Signal::SIGKILL
    } else {
        Signal::SIGTERM
    };
    match killpg(Pid::from_raw(group), signal) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        // Darwin reports EPERM for a group whose remaining members are all
        // zombies awaiting their parent; there is nothing left to signal.
        Err(Errno::EPERM) if group_has_only_zombies(pid) => Ok(()),
        Err(error) => Err(CommandError::new(
            "command_termination_failed",
            format!("Failed to deliver {signal:?} while terminating the command: {error}",),
        )),
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
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;

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
            Ok(_) => false,
            // libproc (pinned) reports `..., errno = <n>, message = ...`.
            Err(message) if message.contains(&format!(", errno = {}, ", Errno::ESRCH as i32)) => {
                matches!(kill(Pid::from_raw(pid), None), Ok(()) | Err(Errno::ESRCH))
            }
            Err(_) => false,
        }
    })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn group_has_only_zombies(_group: u32) -> bool {
    false
}

#[cfg(not(unix))]
pub(super) fn signal_pid(_pid: u32, _force: bool) -> Result<(), CommandError> {
    Ok(())
}

pub(super) fn signal_command(
    host: &dyn ProcessHost,
    child: &mut Child,
    pid: u32,
    force: bool,
) -> Result<(), CommandError> {
    #[cfg(unix)]
    {
        let _ = child;
        host.signal_group(pid, force)
    }
    #[cfg(not(unix))]
    {
        let _ = (host, pid, force);
        match child.start_kill() {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidInput
                ) =>
            {
                Ok(())
            }
            Err(error) => Err(CommandError::io(error)),
        }
    }
}

#[cfg(unix)]
pub(super) fn signal_name(status: ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|number| match number {
        2 => "SIGINT".to_owned(),
        9 => "SIGKILL".to_owned(),
        15 => "SIGTERM".to_owned(),
        _ => format!("SIG{number}"),
    })
}

#[cfg(not(unix))]
pub(super) fn signal_name(_status: &ExitStatus) -> Option<String> {
    None
}

pub(super) async fn terminate_and_reap(
    host: &dyn ProcessHost,
    child: &mut Child,
) -> Result<(), CommandError> {
    let pid = child.id();
    let signalled = match pid {
        Some(pid) => signal_command(host, child, pid, false),
        None => Ok(()),
    };
    if let Err(error) = signalled {
        let _ = child.start_kill();
        let _ = host.wait(child).await;
        return Err(error);
    }
    let waited = tokio::time::timeout(TERMINATION_GRACE, host.wait(child)).await;
    // Partial pipeline startup is a failure boundary: descendants of an
    // already-exited direct child must still be terminated before admission ends.
    if let Some(pid) = pid
        && let Err(error) = host.signal_group(pid, true)
    {
        let _ = child.start_kill();
        let _ = host.wait(child).await;
        return Err(error);
    }
    match waited {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => {
            let _ = child.start_kill();
            let _ = host.wait(child).await;
            Err(CommandError::new("command_wait_failed", error.to_string()))
        }
        Err(_) => host
            .wait(child)
            .await
            .map(|_| ())
            .map_err(|error| CommandError::new("command_wait_failed", error.to_string())),
    }
}
