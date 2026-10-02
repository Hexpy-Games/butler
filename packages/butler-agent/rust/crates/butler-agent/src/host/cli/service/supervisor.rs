//! Detached CLI supervision when no reachable manager owns this DATA.
//! A clean service exit ends supervision. Crashes back off, at most five in a minute.

use std::{
    process::{ExitCode, Stdio},
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

pub(super) const VARIABLE: &str = "BUTLER_CLI_SUPERVISOR";

pub(super) async fn run(
    installation: &crate::host::ResolvedInstallation,
    data: Option<&str>,
) -> Result<ExitCode, crate::host::HostError> {
    let root = super::lifecycle::resolve_data_root(data, installation)?;
    let _lease = lease(&root)?.ok_or("native_service_supervisor_already_running")?;
    let version = crate::host::service::diagnostics::version(installation);
    let mut crashes = std::collections::VecDeque::new();
    let mut signals = butler_platform::process_control::shutdown_requests().map_err(io)?;
    loop {
        let began = Instant::now();
        let (mut child, stdout, stderr) = spawn()?;
        let pid = child.id().unwrap_or_default();
        let status = tokio::select! {
            status = child.wait() => status.map_err(io)?,
            _ = signals.recv() => {
                // Only the child we started is targeted; kill also closes relay pipes.
                child.kill().await.map_err(io)?;
                butler_core::diagnostic!("[service-lifecycle] event=exit version={version} pid={pid} code=supervisor_stop Service was terminated because its CLI supervisor was stopped.");
                let _ = stdout.await;
                let _ = stderr.await;
                return Ok(ExitCode::SUCCESS);
            }
        };
        stdout
            .await
            .map_err(|_| "native_log_relay_failed")?
            .map_err(io)?;
        stderr
            .await
            .map_err(|_| "native_log_relay_failed")?
            .map_err(io)?;
        let reason = butler_platform::process_control::terminating_signal(status)
            .map(butler_platform::process_control::ExitSignal::name)
            .unwrap_or_else(|| format!("exit_{}", status.code().unwrap_or(1)));
        butler_core::diagnostic!(
            "[service-supervisor] event=exit child_pid={} code={reason} Service process exited; {}.",
            pid,
            if status.success() {
                "supervision stops"
            } else {
                "restart scheduled"
            }
        );
        if butler_platform::process_control::terminating_signal(status).is_some() {
            butler_core::diagnostic!(
                "[service-lifecycle] event=exit version={version} pid={pid} code={reason} Service was terminated by a signal."
            );
        }
        if status.success() || requested_stop(&root, pid) {
            return Ok(ExitCode::SUCCESS);
        }
        let now = Instant::now();
        crashes.retain(|crash| now.duration_since(*crash) < Duration::from_secs(60));
        crashes.push_back(began);
        if crashes.len() >= 5 {
            butler_core::diagnostic!(
                "[service-supervisor] event=exit version={version} pid={} code=crash_loop_cap Five crashes in one minute; run butler start after fixing the cause.",
                std::process::id()
            );
            return Ok(ExitCode::FAILURE);
        }
        let delay = Duration::from_millis(250 * (1 << (crashes.len() - 1)));
        tokio::select! {
            () = tokio::time::sleep(delay) => {},
            _ = signals.recv() => return Ok(ExitCode::SUCCESS),
        }
    }
}

fn requested_stop(root: &std::path::Path, pid: u32) -> bool {
    let intent = std::fs::read(root.join("state/agent-stop-intent.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    intent.is_some_and(|intent| {
        intent["schema"] == "butler.agent-stop-intent.v1" && intent["pid"] == pid
    })
}

type Relay = tokio::task::JoinHandle<std::io::Result<()>>;

fn spawn() -> Result<(tokio::process::Child, Relay, Relay), crate::host::HostError> {
    let executable = butler_platform::process_names::current_exe().map_err(io)?;
    let mut command = tokio::process::Command::new(executable);
    command
        .args(std::env::args_os().skip(1))
        .env_remove(VARIABLE)
        .env("BUTLER_CLI_SUPERVISOR_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    butler_platform::process_control::isolate_group(command.as_std_mut());
    let mut child = command.spawn().map_err(io)?;
    let stdout = child.stdout.take().ok_or("native_log_pipe_unavailable")?;
    let stderr = child.stderr.take().ok_or("native_log_pipe_unavailable")?;
    Ok((
        child,
        tokio::spawn(relay(stdout, false)),
        tokio::spawn(relay(stderr, true)),
    ))
}

async fn relay(pipe: impl AsyncRead + Unpin, stderr: bool) -> std::io::Result<()> {
    let mut lines = BufReader::new(pipe).lines();
    while let Some(line) = lines.next_line().await? {
        // Native diagnostic sites already have timestamps; third-party output may not.
        let stamped =
            chrono::DateTime::parse_from_rfc3339(line.split_whitespace().next().unwrap_or(""))
                .is_ok();
        let line = if stamped {
            line
        } else {
            butler_core::diagnostics::timestamped(&line)
        };
        if stderr {
            eprintln!("{line}");
        } else {
            println!("{line}");
        }
    }
    Ok(())
}

fn io(source: std::io::Error) -> crate::host::HostError {
    crate::host::HostError::new("native_service_supervisor_io_failed").with_source(source)
}

// One supervisor owns DATA across child lifetimes, including restart backoff.
fn lease(
    root: &std::path::Path,
) -> Result<Option<butler_platform::instance::InstanceLock>, crate::host::HostError> {
    let path = root.join("state/agent-cli-supervisor.lock");
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    butler_platform::secure_fs::owner_only(&mut options);
    butler_platform::secure_fs::no_follow(&mut options);
    match butler_platform::instance::InstanceLock::try_exclusive(options.open(path).map_err(io)?) {
        Ok(lock) => Ok(Some(lock)),
        Err(butler_platform::instance::LockError::Busy) => Ok(None),
        Err(butler_platform::instance::LockError::Failed(source)) => Err(io(source)),
    }
}

pub(super) async fn existing(
    root: &std::path::Path,
) -> Result<Option<crate::host::service::instance::InstanceRecord>, crate::host::HostError> {
    if !root.join("state/agent-cli-supervisor.lock").exists() {
        return Ok(None);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while lease(root)?.is_none() {
        match super::lifecycle::active_service(root) {
            Ok(Some(record)) => return Ok(Some(record)),
            Ok(None) => {}
            Err(error) if error.message().contains("DATA lock has no record") => {}
            Err(error) => return Err(error),
        }
        if Instant::now() >= deadline {
            return Err("native_service_supervisor_restart_timeout".into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok(None)
}
