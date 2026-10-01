use std::future::Future;
use std::io;
use std::pin::Pin;
use std::process::ExitStatus;
use std::time::Duration;

use butler_platform::process_control::{self, ExitSignal, SignalError};
use tokio::fs::File;
use tokio::io::AsyncWrite;
use tokio::process::{Child, Command};

use super::CommandError;
use crate::workspace::CommandCode;

pub(crate) use butler_platform::process_control::GroupSignal;

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
        Box::pin(spawn_contained(command))
    }

    /// Signals the process group led by `pid`. A group that no longer exists
    /// is already terminated.
    fn signal_group(&self, pid: u32, signal: GroupSignal) -> Result<(), CommandError> {
        signal_pid(pid, signal)
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

/// Starts `command` and contains its process tree (see
/// `process_control::contain`). A command that cannot be contained is
/// stopped and reaped instead of running uncontained.
pub(super) async fn spawn_contained(command: &mut Command) -> io::Result<Child> {
    let mut child = command.spawn()?;
    if let Err(error) = process_control::contain(&child) {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err(error);
    }
    Ok(child)
}

/// Signals the process group led by `pid`. A host that does not contain
/// process trees has no group to signal.
pub(super) fn signal_pid(pid: u32, signal: GroupSignal) -> Result<(), CommandError> {
    match process_control::signal_group(pid, signal) {
        Ok(()) | Err(SignalError::Unsupported) => Ok(()),
        Err(error @ SignalError::InvalidPid(_)) => Err(CommandError::new(
            CommandCode::CommandTerminationFailed,
            "The child process ID is outside the supported signal range",
        )
        .with_source(error)),
        Err(SignalError::Delivery { signal, detail }) => Err(CommandError::new(
            CommandCode::CommandTerminationFailed,
            format!("Failed to deliver {signal} while terminating the command: {detail}"),
        )),
    }
}

/// Signals the command's process tree; a host that does not contain process
/// trees stops the direct child instead.
pub(super) fn signal_command(
    host: &dyn ProcessHost,
    child: &mut Child,
    pid: u32,
    signal: GroupSignal,
) -> Result<(), CommandError> {
    if process_control::CONTAINS_PROCESS_TREES {
        return host.signal_group(pid, signal);
    }
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

/// The name of the signal that terminated the command, if one did.
pub(super) fn signal_name(status: ExitStatus) -> Option<String> {
    process_control::terminating_signal(status).map(ExitSignal::name)
}

pub(super) async fn terminate_and_reap(
    host: &dyn ProcessHost,
    child: &mut Child,
) -> Result<(), CommandError> {
    let pid = child.id();
    let signalled = match pid {
        Some(pid) => signal_command(host, child, pid, GroupSignal::Terminate),
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
        && let Err(error) = host.signal_group(pid, GroupSignal::Kill)
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
            Err(CommandError::new(
                CommandCode::CommandWaitFailed,
                error.to_string(),
            ))
        }
        Err(_) => host.wait(child).await.map(|_| ()).map_err(|error| {
            CommandError::new(CommandCode::CommandWaitFailed, error.to_string()).with_source(error)
        }),
    }
}
