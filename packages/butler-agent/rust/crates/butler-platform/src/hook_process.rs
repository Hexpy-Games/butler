//! Unsandboxed, bounded lifecycle command processes under the user's privileges.
use crate::{
    command_sandbox::{self, CommandOutputDecoder, ShellAccess},
    process_control::{self, GroupSignal},
};
use std::{collections::HashMap, path::PathBuf, process::Stdio, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
/// A command invocation; argv and shell forms are mutually exclusive.
pub struct HookProcess {
    /// Shell command, run with the platform login shell.
    pub command: Option<String>,
    /// Executable plus literal arguments.
    pub args: Option<Vec<String>>,
    /// Sanitized environment plus explicit user additions.
    pub environment: HashMap<String, String>,
    /// Project root or home.
    pub cwd: PathBuf,
    /// Full UTF-8 envelope, never truncated.
    pub stdin: Vec<u8>,
    /// Hard deadline.
    pub timeout: Duration,
}
/// Complete bounded output; failure never becomes truncated success.
pub struct HookOutput {
    /// Exit code, absent when terminated by signal.
    pub exit_code: Option<i32>,
    /// Strict UTF-8 stdout.
    pub stdout: String,
    /// Platform-decoded stderr.
    pub stderr: String,
}
/// Process failure classified for the run log.
#[derive(Debug, thiserror::Error)]
pub enum HookProcessError {
    /// Hard deadline.
    #[error("Hook timed out")]
    Timeout,
    /// Turn cancellation or service shutdown.
    #[error("Hook cancelled")]
    Cancelled,
    /// Stream exceeds the 64 KiB cap.
    #[error("Hook output exceeds 64 KiB")]
    OutputLimit,
    /// Spawn, pipe or UTF-8 failure.
    #[error("Hook process: {0}")]
    Process(String),
}
struct Tree(u32);
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = process_control::signal_group(self.0, GroupSignal::Kill);
    }
}
fn error(e: impl std::fmt::Display) -> HookProcessError {
    HookProcessError::Process(e.to_string())
}
fn prepare(input: &HookProcess) -> Result<std::process::Command, HookProcessError> {
    let mut command = if let Some(text) = &input.command {
        let invocation = command_sandbox::login_shell(text, ShellAccess::Full, &input.environment)
            .map_err(error)?;
        let mut command = std::process::Command::new(&invocation.program);
        command_sandbox::add_arguments(&mut command, &invocation);
        command
    } else {
        let args = input.args.as_ref().ok_or_else(|| error("Missing argv"))?;
        let mut command =
            std::process::Command::new(args.first().ok_or_else(|| error("Empty argv"))?);
        command.args(args.iter().skip(1));
        command
    };
    command
        .current_dir(command_sandbox::working_directory(&input.cwd).map_err(error)?)
        .env_clear()
        .envs(&input.environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    process_control::hide_console(&mut command);
    process_control::isolate_group(&mut command);
    Ok(command)
}
/// Starts one contained tree and drains all pipes concurrently with stdin.
pub async fn run(
    input: HookProcess,
    cancel: CancellationToken,
) -> Result<HookOutput, HookProcessError> {
    let timeout = input.timeout;
    let (command, payload) =
        tokio::task::spawn_blocking(move || prepare(&input).map(|command| (command, input.stdin)))
            .await
            .map_err(error)??;
    if cancel.is_cancelled() {
        return Err(HookProcessError::Cancelled);
    }
    let mut child = tokio::process::Command::from(command)
        .kill_on_drop(true)
        .spawn()
        .map_err(error)?;
    let pid = child.id().ok_or_else(|| error("Missing process id"))?;
    let tree = Tree(pid);
    if let Err(e) = process_control::contain(&child) {
        let _ = child.kill().await;
        return Err(error(e));
    }
    let mut stdin = child.stdin.take().ok_or_else(|| error("Missing stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| error("Missing stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| error("Missing stderr"))?;
    let result = {
        let io = async {
            let write = async move {
                // A handler may intentionally exit without reading stdin.
                let result = match stdin.write_all(&payload).await {
                    Ok(()) => {
                        let _ = stdin.shutdown().await;
                        Ok(())
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
                    Err(e) => Err(error(e)),
                };
                drop(stdin); // EOF must precede waiting for the handler.
                result
            };
            let wait = async { child.wait().await.map_err(error) };
            let ((), out, err, status) =
                tokio::try_join!(write, read(stdout, true), read(stderr, false), wait)?;
            Ok(HookOutput {
                exit_code: status.code(),
                stdout: out,
                stderr: err,
            })
        };
        tokio::select! {
            result = tokio::time::timeout(timeout, io) => result.unwrap_or(Err(HookProcessError::Timeout)),
            () = cancel.cancelled() => Err(HookProcessError::Cancelled),
        }
    };
    if result.is_err() {
        let _ = process_control::signal_group(pid, GroupSignal::Terminate);
        tokio::time::sleep(Duration::from_secs(2)).await;
        let _ = process_control::signal_group(pid, GroupSignal::Kill);
        let _ = child.wait().await;
    }
    drop(tree); // Successful handlers cannot leave background descendants either.
    result
}
async fn read(
    mut stream: impl AsyncRead + Unpin,
    strict: bool,
) -> Result<String, HookProcessError> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let n = stream.read(&mut buffer).await.map_err(error)?;
        if n == 0 {
            break;
        }
        if bytes.len() + n > 65_536 {
            return Err(HookProcessError::OutputLimit);
        }
        bytes.extend(buffer.iter().take(n));
    }
    if strict {
        return String::from_utf8(bytes).map_err(error);
    }
    let mut decoder = CommandOutputDecoder::default();
    let mut text = String::new();
    decoder.write(&bytes, &mut text);
    decoder.end(&mut text);
    if text.len() > 65_536 {
        return Err(HookProcessError::OutputLimit);
    }
    Ok(text)
}
