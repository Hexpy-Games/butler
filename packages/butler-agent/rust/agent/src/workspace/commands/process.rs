use std::process::ExitStatus;
use std::time::Duration;

use tokio::process::Child;

use super::CommandError;

pub(super) const TERMINATION_GRACE: Duration = Duration::from_millis(500);
pub(super) const FORCE_SETTLEMENT_GRACE: Duration = Duration::from_millis(500);

#[cfg(unix)]
pub(super) fn signal_group(child: &mut Child, force: bool) -> Result<(), CommandError> {
    let Some(pid) = child.id() else {
        return Ok(());
    };
    signal_pid(pid, force)
}

#[cfg(unix)]
pub(super) fn signal_pid(pid: u32, force: bool) -> Result<(), CommandError> {
    use nix::errno::Errno;
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;

    let pid = i32::try_from(pid).map_err(|_| {
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
    match killpg(Pid::from_raw(pid), signal) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        Err(error) => Err(CommandError::new(
            "command_termination_failed",
            format!("Failed to deliver {signal:?} while terminating the command: {error}",),
        )),
    }
}

#[cfg(not(unix))]
pub(super) fn signal_group(child: &mut Child, force: bool) -> Result<(), CommandError> {
    if force {
        child.start_kill().map_err(CommandError::io)
    } else {
        child.start_kill().map_err(CommandError::io)
    }
}

#[cfg(not(unix))]
pub(super) fn signal_pid(_pid: u32, _force: bool) -> Result<(), CommandError> {
    Ok(())
}

pub(super) fn signal_command(child: &mut Child, pid: u32, force: bool) -> Result<(), CommandError> {
    #[cfg(unix)]
    {
        let _ = child;
        signal_pid(pid, force)
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, force);
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
pub(super) fn signal_name(status: &ExitStatus) -> Option<String> {
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

pub(super) async fn terminate_and_reap(child: &mut Child) -> Result<(), CommandError> {
    let pid = child.id();
    if let Err(error) = signal_group(child, false) {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err(error);
    }
    let waited = tokio::time::timeout(TERMINATION_GRACE, child.wait()).await;
    // Partial pipeline startup is a failure boundary: descendants of an
    // already-exited direct child must still be terminated before admission ends.
    if let Some(pid) = pid
        && let Err(error) = signal_pid(pid, true)
    {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err(error);
    }
    match waited {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Err(CommandError::new("command_wait_failed", error.to_string()))
        }
        Err(_) => child
            .wait()
            .await
            .map(|_| ())
            .map_err(|error| CommandError::new("command_wait_failed", error.to_string())),
    }
}
