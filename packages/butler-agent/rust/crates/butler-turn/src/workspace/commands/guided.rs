use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use butler_platform::command_sandbox::{self, SandboxError, ShellAccess};
use butler_platform::process_control;
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::environment::guided_environment;
use super::process::{
    FORCE_SETTLEMENT_GRACE, GroupSignal, ProcessHost, TERMINATION_GRACE, signal_command,
    signal_name,
};
use super::spool::{Capture, CaptureEnd, Spool, SpoolPaths};
use super::{CommandError, GuidedAccess, GuidedCommandInput, GuidedCommandOutput, GuidedSummary};
use crate::workspace::CommandCode;
use crate::workspace::path_guard::{GuardInput, lexical_absolute, resolve_workspace_path_guard};

pub(super) async fn dispatch(
    host: &dyn ProcessHost,
    input: GuidedCommandInput,
    shutdown: CancellationToken,
    completion: oneshot::Sender<Result<GuidedCommandOutput, CommandError>>,
) {
    let mut completion = Some(completion);
    let outcome = execute(host, input, shutdown, &mut completion).await;
    // `execute` returns `Ok(None)` only after it settled the completion itself.
    let Some(sender) = completion else {
        return;
    };
    let result = match outcome {
        Ok(Some(output)) => Ok(output),
        Ok(None) => Err(CommandError::new(
            CommandCode::CommandSettlementLost,
            "Command result was settled without a completion",
        )),
        Err(error) => Err(error),
    };
    send_completion(sender, result).await;
}

/// Why the direct child stopped running.
enum Cause {
    Exited(ExitStatus),
    TimedOut,
    /// Aborted by the caller or by owner shutdown.
    Cancelled,
    /// Waiting on the child or capturing its output failed.
    Failed(CommandError),
}

/// How the command settled after its child stopped.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stopped {
    Exited,
    TimedOut,
    Cancelled,
}

/// Whether the child was reaped within the termination and force graces.
enum Reaped {
    Exited(ExitStatus),
    /// Still unreaped after SIGKILL; the result settles without its status.
    Unreaped,
}

/// A spawned command whose output is being spooled.
struct Running {
    child: Child,
    pid: u32,
    capture: Capture,
    paths: SpoolPaths,
}

impl Running {
    /// Kills and reaps the child, drops the capture and reports `error`.
    async fn fail(
        mut self,
        host: &dyn ProcessHost,
        error: CommandError,
    ) -> Result<Option<GuidedCommandOutput>, CommandError> {
        let _ = signal_command(host, &mut self.child, self.pid, GroupSignal::Kill);
        let _ = self.child.start_kill();
        let _ = host.wait(&mut self.child).await;
        self.capture.stop();
        let _ = self.capture.finish(CaptureEnd::Stopped).await;
        self.paths.discard().await;
        Err(error)
    }
}

async fn execute(
    host: &dyn ProcessHost,
    input: GuidedCommandInput,
    shutdown: CancellationToken,
    completion: &mut Option<oneshot::Sender<Result<GuidedCommandOutput, CommandError>>>,
) -> Result<Option<GuidedCommandOutput>, CommandError> {
    let (cwd, command) = prepare_command(&input, &shutdown).await?;
    let spool = Spool::create(&input.butler_data).await?;
    let mut running = spawn_captured(host, command, spool).await?;
    let cause = await_stop(host, &mut running, &input, &shutdown).await;
    let (stopped, reaped) = match settle_process(host, &mut running, cause).await {
        Ok(settled) => settled,
        Err(error) => return running.fail(host, error).await,
    };
    let summary = |exit_code, signal, timed_out| GuidedSummary {
        command: input.command.clone(),
        cwd: cwd.to_string_lossy().into_owned(),
        exit_code,
        signal,
        timed_out,
    };
    let status = match reaped {
        Reaped::Exited(status) => status,
        Reaped::Unreaped => {
            running.capture.stop();
            let result = match stopped {
                Stopped::Cancelled => discard_cancelled(running.capture, running.paths).await,
                Stopped::Exited | Stopped::TimedOut => {
                    complete(running.paths, running.capture, summary(None, None, true)).await
                }
            };
            if let Some(sender) = completion.take() {
                send_completion(sender, result).await;
            }
            // The public result is settled; the owner stays active until reaped.
            let _ = host.wait(&mut running.child).await;
            return Ok(None);
        }
    };
    if stopped == Stopped::Cancelled {
        running.capture.stop();
        return discard_cancelled(running.capture, running.paths)
            .await
            .map(Some);
    }
    let timed_out = stopped == Stopped::TimedOut;
    let exit_code = if timed_out { None } else { status.code() };
    let summary = summary(exit_code, signal_name(status), timed_out);
    let payload_source = running
        .paths
        .complete(running.capture, &summary, CaptureEnd::Drained)
        .await?;
    Ok(Some(GuidedCommandOutput {
        summary,
        payload_source,
    }))
}

/// Validates the input and builds the sandboxed command with its guarded
/// working directory and environment. Refuses once the owner is closing.
async fn prepare_command(
    input: &GuidedCommandInput,
    shutdown: &CancellationToken,
) -> Result<(PathBuf, Command), CommandError> {
    if input.command.is_empty() {
        return Err(CommandError::new(
            CommandCode::CommandInvalid,
            "command must be a string",
        ));
    }
    let cwd = resolve_guided_cwd(&input.workspace_root, input.cwd.as_deref()).await?;
    let (executable, arguments) = invocation(input)?;
    let environment = tokio::task::spawn_blocking({
        let host = input.host_environment.clone();
        let butler_data = input.butler_data.clone();
        move || guided_environment(&host, &butler_data)
    })
    .await
    .map_err(|error| {
        CommandError::new(CommandCode::CommandEnvironmentFailed, error.to_string())
            .with_source(error)
    })??;
    if shutdown.is_cancelled() {
        return Err(CommandError::new(
            CommandCode::CommandCancelled,
            "Command owner is closing",
        ));
    }
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .current_dir(&cwd)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    process_control::isolate_group(command.as_std_mut());
    Ok((cwd, command))
}

async fn spawn_captured(
    host: &dyn ProcessHost,
    mut command: Command,
    spool: Spool,
) -> Result<Running, CommandError> {
    let mut child = match host.spawn(&mut command).await {
        Ok(child) => child,
        Err(error) => {
            spool.discard().await;
            return Err(CommandError::io(error));
        }
    };
    let (Some(pid), Some(stdout), Some(stderr)) =
        (child.id(), child.stdout.take(), child.stderr.take())
    else {
        // `kill_on_drop` stops the child when it is dropped here.
        spool.discard().await;
        return Err(CommandError::new(
            CommandCode::CommandSpawnFailed,
            "Spawned command has no pid or piped output",
        ));
    };
    let (paths, capture) = spool.capture(host, stdout, stderr);
    Ok(Running {
        child,
        pid,
        capture,
        paths,
    })
}

/// Waits for the first of: exit, timeout, abort, owner shutdown or a capture failure.
async fn await_stop(
    host: &dyn ProcessHost,
    running: &mut Running,
    input: &GuidedCommandInput,
    shutdown: &CancellationToken,
) -> Cause {
    let abort = &input.abort;
    if abort.is_cancelled() {
        return Cause::Cancelled;
    }
    tokio::select! {
        result = host.wait(&mut running.child) => match result {
            Ok(status) => Cause::Exited(status),
            Err(error) => Cause::Failed(CommandError::io(error)),
        },
        () = tokio::time::sleep(guided_timeout(input.timeout_ms)) => Cause::TimedOut,
        () = abort.cancelled() => Cause::Cancelled,
        () = shutdown.cancelled() => Cause::Cancelled,
        error = running.capture.failure() => Cause::Failed(error),
    }
}

/// Stops the process group and reaps the child. An exited child still has
/// its group killed, as Node's close handler kills descendants.
async fn settle_process(
    host: &dyn ProcessHost,
    running: &mut Running,
    cause: Cause,
) -> Result<(Stopped, Reaped), CommandError> {
    let stopped = match cause {
        Cause::Failed(error) => return Err(error),
        Cause::Exited(status) => {
            host.signal_group(running.pid, GroupSignal::Kill)?;
            return Ok((Stopped::Exited, Reaped::Exited(status)));
        }
        Cause::TimedOut => Stopped::TimedOut,
        Cause::Cancelled => Stopped::Cancelled,
    };
    Ok((stopped, terminate(host, running).await?))
}

/// SIGTERM, then SIGKILL after the termination grace, then gives up waiting
/// after the force-settlement grace.
async fn terminate(host: &dyn ProcessHost, running: &mut Running) -> Result<Reaped, CommandError> {
    let pid = running.pid;
    signal_command(host, &mut running.child, pid, GroupSignal::Terminate)?;
    match tokio::time::timeout(TERMINATION_GRACE, host.wait(&mut running.child)).await {
        Ok(Ok(status)) => {
            host.signal_group(pid, GroupSignal::Kill)?;
            return Ok(Reaped::Exited(status));
        }
        Ok(Err(error)) => return Err(CommandError::io(error)),
        Err(_) => {}
    }
    signal_command(host, &mut running.child, pid, GroupSignal::Kill)?;
    match tokio::time::timeout(FORCE_SETTLEMENT_GRACE, host.wait(&mut running.child)).await {
        Ok(Ok(status)) => Ok(Reaped::Exited(status)),
        Ok(Err(error)) => Err(CommandError::io(error)),
        Err(_) => Ok(Reaped::Unreaped),
    }
}

/// Drops the spooled output of a cancelled command and reports the cancellation.
async fn discard_cancelled<T>(capture: Capture, paths: SpoolPaths) -> Result<T, CommandError> {
    let finished = capture.finish(CaptureEnd::Stopped).await;
    paths.discard().await;
    finished.and(Err(CommandError::new(
        CommandCode::CommandCancelled,
        "Command cancelled",
    )))
}

async fn complete(
    paths: SpoolPaths,
    capture: Capture,
    summary: GuidedSummary,
) -> Result<GuidedCommandOutput, CommandError> {
    paths
        .complete(capture, &summary, CaptureEnd::Stopped)
        .await
        .map(|payload_source| GuidedCommandOutput {
            summary,
            payload_source,
        })
}

async fn send_completion(
    sender: oneshot::Sender<Result<GuidedCommandOutput, CommandError>>,
    result: Result<GuidedCommandOutput, CommandError>,
) {
    if let Err(Ok(output)) = sender.send(result) {
        let _ = tokio::fs::remove_file(output.payload_source.path).await;
    }
}

pub(super) async fn resolve_guided_cwd(
    root: &std::path::Path,
    cwd: Option<&str>,
) -> Result<PathBuf, CommandError> {
    let root = root.to_path_buf();
    let cwd = cwd.map(str::to_owned);
    tokio::task::spawn_blocking(move || guarded_directory(&root, cwd.as_deref()))
        .await
        .map_err(|error| {
            CommandError::new(CommandCode::CommandCwdFailed, error.to_string()).with_source(error)
        })?
}

pub(super) fn guarded_directory(
    root: &std::path::Path,
    cwd: Option<&str>,
) -> Result<PathBuf, CommandError> {
    let Some(requested) = cwd.filter(|value| !value.is_empty()) else {
        return Ok(root.to_path_buf());
    };
    if std::path::Path::new(requested).is_absolute()
        && lexical_absolute(std::path::Path::new(requested)).map_err(CommandError::io)?
            == lexical_absolute(root).map_err(CommandError::io)?
    {
        return Ok(root.to_path_buf());
    }
    let result = resolve_workspace_path_guard(GuardInput {
        root,
        requested,
        path_form: crate::workspace::PathForm::RelativeOrAbsolute,
        allow_directories: true,
        protected_roots: &[],
    })
    .map_err(CommandError::io)?;
    if let Some(reason) = result.reason {
        return Err(CommandError::CwdRejected { reason });
    }
    result.absolute.ok_or_else(|| {
        CommandError::new(
            CommandCode::CommandCwdRejected,
            "The requested command directory was not resolved",
        )
    })
}

/// The login-shell invocation of a guided command. Read-only commands run in
/// the host sandbox; a host without one refuses them.
fn invocation(input: &GuidedCommandInput) -> Result<(String, Vec<String>), CommandError> {
    let access = match input.access {
        GuidedAccess::FullAccessContained => ShellAccess::Full,
        GuidedAccess::ReadOnlyObservation => ShellAccess::ReadOnly,
    };
    let invocation = command_sandbox::login_shell(&input.command, access, &input.host_environment)
        .map_err(|SandboxError::ReadOnlyUnavailable| {
            CommandError::new(
                CommandCode::CommandObservationIsolationUnavailable,
                "This host cannot enforce the admitted read-only local command boundary.",
            )
        })?;
    Ok((invocation.program, invocation.arguments))
}

pub(super) fn guided_timeout(value: Option<f64>) -> Duration {
    let value = value.filter(|value| value.is_finite()).unwrap_or(120_000.0);
    // Node timers coerce finite sub-millisecond and nonpositive values to a short tick.
    if value <= 1.0 || value > f64::from(i32::MAX) {
        return Duration::from_millis(1);
    }
    Duration::from_millis(butler_core::json::saturating_u64(value.trunc()))
}
