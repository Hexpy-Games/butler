use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::environment::guided_environment;
use super::process::{
    FORCE_SETTLEMENT_GRACE, TERMINATION_GRACE, signal_command, signal_name, signal_pid,
};
use super::spool::{Capture, Spool, SpoolPaths};
use super::{CommandError, GuidedAccess, GuidedCommandInput, GuidedCommandOutput, GuidedSummary};
use crate::workspace::path_guard::{GuardInput, lexical_absolute, resolve_workspace_path_guard};

pub(super) async fn dispatch(
    input: GuidedCommandInput,
    shutdown: CancellationToken,
    completion: oneshot::Sender<Result<GuidedCommandOutput, CommandError>>,
) {
    let mut completion = Some(completion);
    let outcome = execute(input, shutdown, &mut completion).await;
    if let Some(sender) = completion {
        send_completion(
            sender,
            outcome.map(|output| output.expect("unsettled guided result")),
        )
        .await;
    }
}

async fn execute(
    input: GuidedCommandInput,
    shutdown: CancellationToken,
    completion: &mut Option<oneshot::Sender<Result<GuidedCommandOutput, CommandError>>>,
) -> Result<Option<GuidedCommandOutput>, CommandError> {
    if input.command.is_empty() {
        return Err(CommandError::new(
            "command_invalid",
            "command must be a string",
        ));
    }
    let cwd = resolve_guided_cwd(&input.workspace_root, input.cwd.as_deref()).await?;
    let timeout = guided_timeout(input.timeout_ms);
    let (executable, arguments) = invocation(&input)?;
    let environment = tokio::task::spawn_blocking({
        let host = input.host_environment.clone();
        let butler_data = input.butler_data.clone();
        move || guided_environment(&host, &butler_data)
    })
    .await
    .map_err(|error| CommandError::new("command_environment_failed", error.to_string()))??;
    if shutdown.is_cancelled() {
        return Err(CommandError::new(
            "command_cancelled",
            "Command owner is closing",
        ));
    }
    let spool = Spool::create(&input.butler_data).await?;
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
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            spool.discard().await;
            return Err(CommandError::io(error));
        }
    };
    let pid = child.id().expect("spawned child has pid");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let (paths, mut capture) = spool.capture(stdout, stderr, {
        #[cfg(test)]
        {
            input.test_capture_fail_after_first_chunk
        }
        #[cfg(not(test))]
        {
            false
        }
    });

    enum Cause {
        Normal,
        Timeout,
        Abort,
        Shutdown,
        Capture(CommandError),
    }
    let (cause, mut status) = if input.abort.is_cancelled() {
        (Cause::Abort, None)
    } else {
        tokio::select! {
            result = child.wait() => match result {
                Ok(status) => (Cause::Normal, Some(status)),
                Err(error) => return cleanup_error(&mut child, pid, capture, paths, CommandError::io(error)).await,
            },
            _ = tokio::time::sleep(timeout) => (Cause::Timeout, None),
            _ = input.abort.cancelled() => (Cause::Abort, None),
            _ = shutdown.cancelled() => (Cause::Shutdown, None),
            error = capture.failure() => (Cause::Capture(error), None),
        }
    };
    let mut forced_output_close = false;
    let mut force_sent = false;
    match cause {
        Cause::Normal => {
            // Node's close handler kills descendants even after the direct child exits.
            #[cfg(unix)]
            if let Err(error) = signal_pid(pid, true) {
                return cleanup_error(&mut child, pid, capture, paths, error).await;
            }
        }
        Cause::Capture(error) => {
            return cleanup_error(&mut child, pid, capture, paths, error).await;
        }
        Cause::Timeout | Cause::Abort | Cause::Shutdown => {
            if let Err(error) = signal_command(&mut child, pid, false) {
                return cleanup_error(&mut child, pid, capture, paths, error).await;
            }
            status = match tokio::time::timeout(TERMINATION_GRACE, child.wait()).await {
                Ok(Ok(status)) => Some(status),
                Ok(Err(error)) => {
                    return cleanup_error(&mut child, pid, capture, paths, CommandError::io(error))
                        .await;
                }
                Err(_) => {
                    if let Err(error) = signal_command(&mut child, pid, true) {
                        return cleanup_error(&mut child, pid, capture, paths, error).await;
                    }
                    force_sent = true;
                    #[cfg(test)]
                    let late_reap = input.test_late_reap.is_some();
                    #[cfg(not(test))]
                    let late_reap = false;
                    if late_reap {
                        tokio::time::sleep(FORCE_SETTLEMENT_GRACE).await;
                        forced_output_close = true;
                        None
                    } else {
                        match tokio::time::timeout(FORCE_SETTLEMENT_GRACE, child.wait()).await {
                            Ok(Ok(status)) => Some(status),
                            Ok(Err(error)) => {
                                return cleanup_error(
                                    &mut child,
                                    pid,
                                    capture,
                                    paths,
                                    CommandError::io(error),
                                )
                                .await;
                            }
                            Err(_) => {
                                forced_output_close = true;
                                None
                            }
                        }
                    }
                }
            };
            #[cfg(unix)]
            if !force_sent && let Err(error) = signal_pid(pid, true) {
                return cleanup_error(&mut child, pid, capture, paths, error).await;
            }
        }
    }
    if forced_output_close {
        capture.stop();
        let result = if matches!(cause, Cause::Abort | Cause::Shutdown) {
            let finished = capture.finish(true).await;
            paths.discard().await;
            finished.and(Err(CommandError::new(
                "command_cancelled",
                "Command cancelled",
            )))
        } else {
            let summary = GuidedSummary {
                command: input.command,
                cwd: cwd.to_string_lossy().into_owned(),
                exit_code: None,
                signal: None,
                timed_out: true,
            };
            paths
                .complete(capture, &summary, true)
                .await
                .map(|payload_source| GuidedCommandOutput {
                    summary,
                    payload_source,
                })
        };
        if let Some(sender) = completion.take() {
            send_completion(sender, result).await;
        }
        #[cfg(test)]
        if let Some(gate) = input.test_late_reap {
            gate.notified().await;
        }
        let _ = child.wait().await;
        return Ok(None);
    }
    if matches!(cause, Cause::Abort | Cause::Shutdown) {
        capture.stop();
        let finished = capture.finish(true).await;
        paths.discard().await;
        return finished.and(Err(CommandError::new(
            "command_cancelled",
            "Command cancelled",
        )));
    }
    let status = status.expect("reaped command");
    let summary = GuidedSummary {
        command: input.command,
        cwd: cwd.to_string_lossy().into_owned(),
        exit_code: if matches!(cause, Cause::Timeout) {
            None
        } else {
            status.code()
        },
        signal: signal_name(&status),
        timed_out: matches!(cause, Cause::Timeout),
    };
    let payload_source = paths
        .complete(capture, &summary, forced_output_close)
        .await?;
    Ok(Some(GuidedCommandOutput {
        summary,
        payload_source,
    }))
}

async fn send_completion(
    sender: oneshot::Sender<Result<GuidedCommandOutput, CommandError>>,
    result: Result<GuidedCommandOutput, CommandError>,
) {
    if let Err(Ok(output)) = sender.send(result) {
        let _ = tokio::fs::remove_file(output.payload_source.path).await;
    }
}

async fn cleanup_error(
    child: &mut tokio::process::Child,
    pid: u32,
    capture: Capture,
    paths: SpoolPaths,
    error: CommandError,
) -> Result<Option<GuidedCommandOutput>, CommandError> {
    let _ = signal_command(child, pid, true);
    let _ = child.start_kill();
    let _ = child.wait().await;
    capture.stop();
    let _ = capture.finish(true).await;
    paths.discard().await;
    Err(error)
}

pub(super) async fn resolve_guided_cwd(
    root: &std::path::Path,
    cwd: Option<&str>,
) -> Result<PathBuf, CommandError> {
    let root = root.to_path_buf();
    let cwd = cwd.map(str::to_owned);
    tokio::task::spawn_blocking(move || guarded_directory(&root, cwd.as_deref()))
        .await
        .map_err(|error| CommandError::new("command_cwd_failed", error.to_string()))?
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
        relative_only: false,
        allow_directories: true,
        protected_roots: &[],
    })
    .map_err(CommandError::io)?;
    if let Some(reason) = result.reason {
        return Err(CommandError::new(
            reason,
            "The requested command directory is outside the admitted workspace safety policy.",
        ));
    }
    result.absolute.ok_or_else(|| {
        CommandError::new(
            "command_cwd_rejected",
            "The requested command directory was not resolved",
        )
    })
}

fn invocation(input: &GuidedCommandInput) -> Result<(String, Vec<String>), CommandError> {
    #[cfg(target_os = "macos")]
    {
        if input.access == GuidedAccess::FullAccessContained {
            Ok(("/bin/sh".into(), vec!["-lc".into(), input.command.clone()]))
        } else {
            let profile = [
                "(version 1)",
                "(allow default)",
                "(deny file-write*)",
                "(allow file-write-data (literal \"/dev/null\"))",
                "(deny network*)",
            ]
            .join("\n");
            Ok((
                "/usr/bin/sandbox-exec".into(),
                vec![
                    "-p".into(),
                    profile,
                    "/bin/sh".into(),
                    "-lc".into(),
                    input.command.clone(),
                ],
            ))
        }
    }
    #[cfg(windows)]
    {
        if input.access != GuidedAccess::FullAccessContained {
            return Err(CommandError::new(
                "command_observation_isolation_unavailable",
                "This host cannot enforce the admitted read-only local command boundary.",
            ));
        }
        let executable = input
            .host_environment
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("ComSpec"))
            .map(|(_, value)| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("cmd.exe")
            .to_owned();
        return Ok((
            executable,
            vec!["/d".into(), "/s".into(), "/c".into(), input.command.clone()],
        ));
    }
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        if input.access != GuidedAccess::FullAccessContained {
            return Err(CommandError::new(
                "command_observation_isolation_unavailable",
                "This host cannot enforce the admitted read-only local command boundary.",
            ));
        }
        Ok(("/bin/sh".into(), vec!["-lc".into(), input.command.clone()]))
    }
}

pub(super) fn guided_timeout(value: Option<f64>) -> Duration {
    let value = value.filter(|value| value.is_finite()).unwrap_or(120_000.0);
    // Node timers coerce finite sub-millisecond and nonpositive values to a short tick.
    if value <= 1.0 || value > i32::MAX as f64 {
        return Duration::from_millis(1);
    }
    Duration::from_millis(value.trunc() as u64)
}
