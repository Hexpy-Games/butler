//! Structured command pipelines: spawn every step, pipe each stdout into the
//! next stdin, supervise timeout/abort/shutdown, and settle the output.

use std::process::{ExitStatus, Stdio};
use std::time::{Duration, SystemTime};

use butler_platform::process_control;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::decode::Utf8Decoder;
use super::process::{FORCE_SETTLEMENT_GRACE, GroupSignal, ProcessHost, TERMINATION_GRACE};
use super::{CommandError, CommandStep, StructuredCommandInput, StructuredCommandOutput};

mod invocation;
mod result;
mod streams;
use crate::workspace::CommandCode;
use invocation::{environment, invocation_steps};
use result::{Captured, Stop, bounded_timeout, failed, pipeline_exit, result};
use streams::{StreamChunk, StreamKind, read_stream};

mod supervisor;
use supervisor::*;

type Completion = Option<oneshot::Sender<StructuredCommandOutput>>;
type IoTask = JoinHandle<std::io::Result<()>>;
type Pipes = (ChildStdin, ChildStdout, ChildStderr);

pub(super) async fn dispatch(
    host: &dyn ProcessHost,
    input: StructuredCommandInput,
    shutdown: CancellationToken,
    completion: oneshot::Sender<StructuredCommandOutput>,
) {
    let timing = (std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
        == Some(std::ffi::OsStr::new("1")))
    .then(std::time::Instant::now);
    let legacy = input.legacy.is_some();
    let mut completion = Some(completion);
    let output = execute(host, input, shutdown, &mut completion).await;
    if let Some(started) = timing {
        eprintln!(
            "command_process_timing legacy={legacy} elapsed_us={}",
            started.elapsed().as_micros()
        );
    }
    if let Some(sender) = completion {
        let _ = sender.send(output);
    }
}

/// Whether the input is a structured plan or a legacy shell command, which
/// reports spawn failures and missing exit codes the way a shell does.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Dialect {
    Structured,
    Legacy,
}

async fn execute(
    host: &dyn ProcessHost,
    input: StructuredCommandInput,
    shutdown: CancellationToken,
    completion: &mut Completion,
) -> StructuredCommandOutput {
    let started = SystemTime::now();
    if input.abort.is_cancelled() {
        let stop = Stop {
            timed_out: false,
            cancelled: true,
        };
        return result(started, Captured::default(), None, stop, None);
    }
    if !process_control::CONTAINS_PROCESS_TREES {
        return failed(
            started,
            CommandError::new(
                CommandCode::CommandPlatformUnavailable,
                "Native structured command containment is unavailable on this host",
            ),
        );
    }
    let dialect = if input.legacy.is_some() {
        Dialect::Legacy
    } else {
        Dialect::Structured
    };
    let steps = match plan_steps(&input, started) {
        Ok(steps) => steps,
        Err(output) => return output,
    };
    let (children, pids, stdio) = match spawn_steps(host, &input, &steps).await {
        Ok(spawned) => spawned,
        Err(failure) => return spawn_failure(started, failure, dialect),
    };
    let Some((io_tasks, chunks)) = connect_pipeline(stdio, input.stdin) else {
        return failed(started, plan_empty());
    };
    let supervisor = Supervisor {
        host,
        statuses: vec![None; children.len()],
        decoders: Decoders::new(children.len()),
        children,
        pids,
        io_tasks,
        captured: Captured::default(),
        stop: Stop::default(),
        closing: false,
        first_termination: None,
        forced: false,
        public_settled: false,
        started,
    };
    let signals = Signals {
        deadline: Instant::now() + bounded_timeout(input.timeout_ms),
        abort: &input.abort,
        shutdown: &shutdown,
    };
    supervisor
        .supervise(chunks, &signals, completion, dialect)
        .await
}

fn plan_empty() -> CommandError {
    CommandError::new(
        CommandCode::CommandPlanEmpty,
        "command plan must contain at least one executable step",
    )
}

/// The executable steps of the input; an empty legacy command settles like a
/// shell usage error (exit 64).
fn plan_steps(
    input: &StructuredCommandInput,
    started: SystemTime,
) -> Result<Vec<CommandStep>, StructuredCommandOutput> {
    let steps = match invocation_steps(input) {
        Ok(steps) => steps,
        Err(error) if error.code() == CommandCode::LegacyCommandEmpty.as_str() => {
            let captured = Captured {
                stdout: String::new(),
                stderr: format!("{}\n", error.message()),
            };
            return Err(result(started, captured, Some(64), Stop::default(), None));
        }
        Err(error) => return Err(failed(started, error)),
    };
    if steps.is_empty() {
        return Err(failed(started, plan_empty()));
    }
    Ok(steps)
}

/// Why spawning a pipeline failed.
enum SpawnFailure {
    /// A step could not be started (the already started ones were reaped).
    Spawn(std::io::Error),
    /// Reaping the already started steps failed.
    Cleanup(CommandError),
}

/// Spawns every step in its own process group with piped stdio. On failure
/// the already started steps are terminated and reaped.
async fn spawn_steps(
    host: &dyn ProcessHost,
    input: &StructuredCommandInput,
    steps: &[CommandStep],
) -> Result<(Vec<Child>, Vec<u32>, Vec<Pipes>), SpawnFailure> {
    let environment = environment(input);
    let mut children = Vec::with_capacity(steps.len());
    let mut pids = Vec::with_capacity(steps.len());
    let mut stdio = Vec::with_capacity(steps.len());
    for step in steps {
        let mut command = step_command(step, &environment, input.cwd.as_deref());
        match spawn_piped(host, &mut command).await {
            Ok((child, pid, pipes)) => {
                pids.push(pid);
                children.push(child);
                stdio.push(pipes);
            }
            Err(spawn_error) => {
                reap_started(host, &mut children).await?;
                return Err(SpawnFailure::Spawn(spawn_error));
            }
        }
    }
    Ok((children, pids, stdio))
}

fn step_command(
    step: &CommandStep,
    environment: &std::collections::HashMap<String, String>,
    cwd: Option<&std::path::Path>,
) -> Command {
    let mut command = Command::new(&step.executable);
    command
        .args(&step.arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .envs(environment)
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    process_control::isolate_group(command.as_std_mut());
    command
}

async fn spawn_piped(
    host: &dyn ProcessHost,
    command: &mut Command,
) -> std::io::Result<(Child, u32, Pipes)> {
    let mut child = host.spawn(command).await?;
    let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    match (child.id(), pipes) {
        (Some(pid), (Some(stdin), Some(stdout), Some(stderr))) => {
            Ok((child, pid, (stdin, stdout, stderr)))
        }
        _ => Err(std::io::Error::other(
            "spawned command has no pid or piped stdio",
        )),
    }
}

/// Terminates and reaps the steps started before a spawn failure; the first
/// cleanup error wins.
async fn reap_started(host: &dyn ProcessHost, children: &mut [Child]) -> Result<(), SpawnFailure> {
    let mut cleanup_error = None;
    for child in children {
        if let Err(error) = super::process::terminate_and_reap(host, child).await
            && cleanup_error.is_none()
        {
            cleanup_error = Some(error);
        }
    }
    cleanup_error.map_or(Ok(()), |error| Err(SpawnFailure::Cleanup(error)))
}

/// A legacy command reports a spawn failure like a shell: on stderr with exit
/// 127 and no structured error.
fn spawn_failure(
    started: SystemTime,
    failure: SpawnFailure,
    dialect: Dialect,
) -> StructuredCommandOutput {
    let spawn_error = match failure {
        SpawnFailure::Cleanup(error) => return failed(started, error),
        SpawnFailure::Spawn(error) => error,
    };
    match dialect {
        Dialect::Structured => failed(
            started,
            CommandError::new(
                CommandCode::CommandSpawnFailed,
                "command process could not be started",
            )
            .with_source(spawn_error),
        ),
        Dialect::Legacy => {
            let error = CommandError::new(
                CommandCode::LegacyShellSpawnFailed,
                "legacy command compatibility process could not be started",
            )
            .with_source(spawn_error);
            let captured = Captured {
                stdout: String::new(),
                stderr: format!("{}\n", error.message()),
            };
            result(started, captured, Some(127), Stop::default(), None)
        }
    }
}

/// Starts the stream readers and the pipes between steps: every stderr and
/// the last stdout are read; each stdout feeds the next stdin; the input text
/// is written to the first stdin. `None` when the plan has no steps.
fn connect_pipeline(
    stdio: Vec<Pipes>,
    stdin_text: String,
) -> Option<(Vec<IoTask>, mpsc::Receiver<StreamChunk>)> {
    let (tx, rx) = mpsc::channel::<StreamChunk>(64);
    let mut io_tasks = Vec::new();
    let mut stdins = Vec::with_capacity(stdio.len());
    let mut stdouts = Vec::with_capacity(stdio.len());
    for (index, (stdin, stdout, stderr)) in stdio.into_iter().enumerate() {
        io_tasks.push(tokio::spawn(read_stream(
            stderr,
            StreamKind::Stderr(index),
            tx.clone(),
        )));
        stdins.push(stdin);
        stdouts.push(stdout);
    }
    let mut stdins = stdins.into_iter();
    let (Some(mut first_stdin), Some(last_stdout)) = (stdins.next(), stdouts.pop()) else {
        return None;
    };
    io_tasks.push(tokio::spawn(read_stream(
        last_stdout,
        StreamKind::Stdout,
        tx.clone(),
    )));
    drop(tx);
    for (mut stdout, mut stdin) in stdouts.into_iter().zip(stdins) {
        io_tasks.push(tokio::spawn(async move {
            let copied = tokio::io::copy(&mut stdout, &mut stdin).await;
            drop(stdin);
            copied.map(|_| ())
        }));
    }
    let stdin_bytes = stdin_text.into_bytes();
    io_tasks.push(tokio::spawn(async move {
        let result = first_stdin.write_all(&stdin_bytes).await;
        drop(first_stdin);
        result
    }));
    Some((io_tasks, rx))
}

/// UTF-8 decoders for the pipeline's stdout and each step's stderr.
struct Decoders {
    stdout: Utf8Decoder,
    stderr: Vec<Utf8Decoder>,
    /// Set once every stream reader has finished.
    done: bool,
}

impl Decoders {
    fn new(steps: usize) -> Self {
        Self {
            stdout: Utf8Decoder::default(),
            stderr: (0..steps).map(|_| Utf8Decoder::default()).collect(),
            done: false,
        }
    }

    fn decode(&mut self, chunk: &StreamChunk, captured: &mut Captured) {
        let (decoder, text) = match chunk.kind {
            StreamKind::Stdout => (&mut self.stdout, &mut captured.stdout),
            StreamKind::Stderr(index) => {
                let Some(decoder) = self.stderr.get_mut(index) else {
                    return;
                };
                (decoder, &mut captured.stderr)
            }
        };
        if chunk.end {
            decoder.end(text);
        } else {
            decoder.write(&chunk.bytes, text);
        }
    }
}
