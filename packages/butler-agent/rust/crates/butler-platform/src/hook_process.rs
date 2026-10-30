//! Bounded lifecycle command processes: under the user's privileges for the user's
//! own hooks, inside the session's sandbox for a project folder's.
use crate::{
    command_sandbox::{self, CommandOutputDecoder, ShellAccess, hook_containment as sandbox},
    process_control::{self, GroupSignal},
};
pub use command_sandbox::hook_containment::{HookContainment, HookSandbox};
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
    /// How far the process may reach.
    pub sandbox: HookSandbox,
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
fn prepare_unsandboxed(input: &HookProcess) -> Result<std::process::Command, HookProcessError> {
    let invocation = input
        .command
        .as_ref()
        .map(|text| {
            command_sandbox::login_shell(text, ShellAccess::Full, &input.environment).map_err(error)
        })
        .transpose()?;
    let mut command = if let Some(invocation) = &invocation {
        std::process::Command::new(&invocation.program)
    } else {
        let args = input.args.as_ref().ok_or_else(|| error("Missing argv"))?;
        let mut command =
            std::process::Command::new(args.first().ok_or_else(|| error("Empty argv"))?);
        command.args(args.iter().skip(1));
        command
    };
    configure(&mut command, input)?;
    if let Some(invocation) = &invocation {
        command_sandbox::add_arguments(&mut command, invocation);
    }
    process_control::hide_console(&mut command);
    process_control::isolate_group(&mut command);
    Ok(command)
}
fn configure(
    command: &mut std::process::Command,
    input: &HookProcess,
) -> Result<(), HookProcessError> {
    command
        .current_dir(command_sandbox::working_directory(&input.cwd).map_err(error)?)
        .env_clear()
        .envs(&input.environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(())
}
/// A hook that cannot be contained fails here and never starts.
fn prepare_contained(
    input: &HookProcess,
) -> Result<(std::process::Command, sandbox::Contained), HookProcessError> {
    let base = sandbox::base(
        input.command.as_deref(),
        input.args.as_deref(),
        &input.environment,
    )
    .map_err(error)?;
    let contained = sandbox::contain(base, &input.sandbox).map_err(error)?;
    let mut command = std::process::Command::new(&contained.invocation.program);
    configure(&mut command, input)?;
    command.envs(contained.scratch.iter().map(|(key, value)| (*key, value)));
    command_sandbox::add_arguments(&mut command, &contained.invocation);
    process_control::hide_console(&mut command);
    process_control::isolate_group(&mut command);
    Ok((command, contained))
}
/// Starts one contained tree and finishes its containment on every exit path.
pub async fn run(
    input: HookProcess,
    cancel: CancellationToken,
) -> Result<HookOutput, HookProcessError> {
    let timeout = input.timeout;
    let (command, payload, contained) = tokio::task::spawn_blocking(move || {
        if matches!(input.sandbox, HookSandbox::None) {
            prepare_unsandboxed(&input).map(|command| (command, input.stdin, None))
        } else {
            prepare_contained(&input)
                .map(|(command, contained)| (command, input.stdin, Some(contained)))
        }
    })
    .await
    .map_err(error)??;
    let result = Box::pin(supervise(command, payload, timeout, cancel)).await;
    if let Some(contained) = contained {
        let _ = tokio::task::spawn_blocking(move || contained.finish()).await;
    }
    result
}
/// Drains all pipes concurrently with stdin, until the tree is gone.
async fn supervise(
    command: std::process::Command,
    payload: Vec<u8>,
    timeout: Duration,
    cancel: CancellationToken,
) -> Result<HookOutput, HookProcessError> {
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
