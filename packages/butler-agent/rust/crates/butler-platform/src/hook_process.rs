//! Unsandboxed, bounded lifecycle command processes under the user's privileges.
use crate::{
    command_sandbox::{self, CommandOutputDecoder},
    process_control::{self, GroupSignal},
};
use std::{
    collections::HashMap,
    path::PathBuf,
    pin::Pin,
    process::Stdio,
    task::{Context, Poll},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
/// Bound of each stream a handler's decision is read from.
pub const OUTPUT_LIMIT: usize = 65_536;
/// Bound of stdout that can become turn context; longer text is budgeted, not cut.
pub const CONTEXT_OUTPUT_LIMIT: usize = 10 * 1024 * 1024;
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
    /// File copied to stdin after the envelope, without buffering it in memory.
    pub stdin_file: Option<PathBuf>,
    /// Hard deadline.
    pub timeout: Duration,
    /// Stdout bound in bytes; stderr always uses `OUTPUT_LIMIT`.
    pub stdout_limit: usize,
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
    /// Stream exceeds its bound, given in bytes.
    #[error("Hook output exceeds {} KiB", .0 / 1024)]
    OutputLimit(usize),
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
    let invocation = input
        .command
        .as_ref()
        .map(|text| command_sandbox::hook_shell(text, &input.environment));
    let mut command = if let Some(invocation) = &invocation {
        std::process::Command::new(&invocation.program)
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
    if let Some(invocation) = &invocation {
        command_sandbox::add_arguments(&mut command, invocation);
    }
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
    let stdout_limit = input.stdout_limit;
    let (command, payload, stdin_file) = tokio::task::spawn_blocking(move || {
        prepare(&input).map(|command| (command, input.stdin, input.stdin_file))
    })
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
    let stdin = child.stdin.take().ok_or_else(|| error("Missing stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| error("Missing stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| error("Missing stderr"))?;
    let result = {
        let io = async {
            let write = write_stdin(stdin, payload, stdin_file);
            let wait = async { child.wait().await.map_err(error) };
            let ((), out, err, status) = tokio::try_join!(
                write,
                read(stdout, true, stdout_limit),
                read(stderr, false, OUTPUT_LIMIT),
                wait
            )?;
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
/// A contained tree whose stdout is read as it arrives; dropping it kills the tree.
pub struct StreamingProcess {
    stdout: tokio::process::ChildStdout,
    child: tokio::process::Child,
    stderr: tokio::task::JoinHandle<String>,
    _tree: Tree,
}

/// Starts one contained tree whose stdout the caller reads; stdin is written and closed in the background.
pub async fn spawn_streaming(
    args: Vec<String>,
    environment: HashMap<String, String>,
    cwd: PathBuf,
    stdin: Vec<u8>,
) -> Result<StreamingProcess, HookProcessError> {
    let input = HookProcess {
        command: None,
        args: Some(args),
        environment,
        cwd,
        stdin,
        stdin_file: None,
        timeout: Duration::ZERO,
        stdout_limit: 0,
    };
    let (command, payload) =
        tokio::task::spawn_blocking(move || prepare(&input).map(|command| (command, input.stdin)))
            .await
            .map_err(error)??;
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
    let stdin = child.stdin.take().ok_or_else(|| error("Missing stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| error("Missing stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| error("Missing stderr"))?;
    tokio::spawn(write_stdin(stdin, payload, None));
    let stderr =
        tokio::spawn(async move { read(stderr, false, OUTPUT_LIMIT).await.unwrap_or_default() });
    Ok(StreamingProcess {
        stdout,
        child,
        stderr,
        _tree: tree,
    })
}

impl StreamingProcess {
    /// Waits up to 10 s for the exit and returns its code and stderr; stdout is empty.
    pub async fn finish(mut self) -> Result<HookOutput, HookProcessError> {
        let status = tokio::time::timeout(Duration::from_secs(10), self.child.wait())
            .await
            .map_err(|_| HookProcessError::Timeout)?
            .map_err(error)?;
        Ok(HookOutput {
            exit_code: status.code(),
            stdout: String::new(),
            stderr: self.stderr.await.unwrap_or_default(),
        })
    }
}

impl AsyncRead for StreamingProcess {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().stdout).poll_read(cx, buf)
    }
}

async fn write_stdin(
    mut stdin: tokio::process::ChildStdin,
    payload: Vec<u8>,
    file: Option<PathBuf>,
) -> Result<(), HookProcessError> {
    let result = async {
        stdin.write_all(&payload).await?;
        if let Some(file) = file {
            let mut file = tokio::fs::File::open(file).await?;
            tokio::io::copy(&mut file, &mut stdin).await?;
        }
        let _ = stdin.shutdown().await;
        Ok::<(), std::io::Error>(())
    }
    .await;
    // A handler may intentionally exit without reading stdin.
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
        Err(e) => Err(error(e)),
    }
}
async fn read(
    mut stream: impl AsyncRead + Unpin,
    strict: bool,
    limit: usize,
) -> Result<String, HookProcessError> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let n = stream.read(&mut buffer).await.map_err(error)?;
        if n == 0 {
            break;
        }
        if bytes.len() + n > limit {
            return Err(HookProcessError::OutputLimit(limit));
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
    if text.len() > limit {
        return Err(HookProcessError::OutputLimit(limit));
    }
    Ok(text)
}
