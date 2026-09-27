//! Structured command pipelines: spawn every step, pipe each stdout into the
//! next stdin, supervise timeout/abort/shutdown, and settle the output.

use std::process::{ExitStatus, Stdio};
use std::time::{Duration, SystemTime};

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

type Completion = Option<oneshot::Sender<StructuredCommandOutput>>;
type IoTask = JoinHandle<std::io::Result<()>>;
type Pipes = (ChildStdin, ChildStdout, ChildStderr);

pub(super) async fn dispatch(
    host: &dyn ProcessHost,
    input: StructuredCommandInput,
    shutdown: CancellationToken,
    completion: oneshot::Sender<StructuredCommandOutput>,
) {
    let mut completion = Some(completion);
    let output = execute(host, input, shutdown, &mut completion).await;
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
    #[cfg(windows)]
    return failed(
        started,
        CommandError::new(
            "command_platform_unavailable",
            "Native structured command containment is unavailable on this host",
        ),
    );
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
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
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

/// The external events that stop a running pipeline.
struct Signals<'a> {
    deadline: Instant,
    abort: &'a CancellationToken,
    shutdown: &'a CancellationToken,
}

/// Owns a running pipeline until every step is reaped and every stream task
/// finished, even after the public result was settled early.
struct Supervisor<'a> {
    host: &'a dyn ProcessHost,
    children: Vec<Child>,
    pids: Vec<u32>,
    statuses: Vec<Option<ExitStatus>>,
    io_tasks: Vec<IoTask>,
    decoders: Decoders,
    captured: Captured,
    stop: Stop,
    closing: bool,
    first_termination: Option<Instant>,
    forced: bool,
    public_settled: bool,
    started: SystemTime,
}

impl Supervisor<'_> {
    async fn supervise(
        mut self,
        mut chunks: mpsc::Receiver<StreamChunk>,
        signals: &Signals<'_>,
        completion: &mut Completion,
        dialect: Dialect,
    ) -> StructuredCommandOutput {
        loop {
            if let Err(error) = self.reap_exited() {
                return self.abandon(error).await;
            }
            if self.settled() {
                break;
            }
            tokio::select! {
                chunk = chunks.recv(), if !self.decoders.done => {
                    self.receive(chunk, completion.is_some());
                }
                () = tokio::time::sleep_until(signals.deadline), if !self.stop.timed_out => {
                    self.stop.timed_out = true;
                    self.request_termination();
                }
                () = signals.abort.cancelled(), if !self.stop.cancelled => {
                    self.stop.cancelled = true;
                    self.request_termination();
                }
                () = signals.shutdown.cancelled(), if !self.closing => {
                    self.stop.cancelled = true;
                    self.closing = true;
                    self.request_termination();
                }
                () = tokio::time::sleep(Duration::from_millis(10)) => {},
            }
            self.enforce_grace(completion);
        }
        self.collect(dialect).await
    }

    /// Records the exit status of every step that has exited.
    fn reap_exited(&mut self) -> std::io::Result<()> {
        for (child, status) in self.children.iter_mut().zip(&mut self.statuses) {
            if status.is_none() {
                *status = self.host.try_wait(child)?;
            }
        }
        Ok(())
    }

    fn settled(&self) -> bool {
        self.statuses.iter().all(Option::is_some)
            && self.decoders.done
            && self.io_tasks.iter().all(JoinHandle::is_finished)
    }

    /// Output after the result was settled early is dropped.
    fn receive(&mut self, chunk: Option<StreamChunk>, completion_open: bool) {
        match chunk {
            Some(chunk) if completion_open => self.decoders.decode(&chunk, &mut self.captured),
            Some(_) => {}
            None => self.decoders.done = true,
        }
    }

    fn request_termination(&mut self) {
        for pid in &self.pids {
            let _ = self.host.signal_group(*pid, GroupSignal::Terminate);
        }
        if self.first_termination.is_none() {
            self.first_termination = Some(Instant::now());
        }
    }

    /// Kills the groups once the termination grace passed and, after the force
    /// grace, settles the public result while the owner keeps reaping.
    fn enforce_grace(&mut self, completion: &mut Completion) {
        let Some(when) = self.first_termination else {
            return;
        };
        if !self.forced && Instant::now() >= when + TERMINATION_GRACE {
            for pid in &self.pids {
                let _ = self.host.signal_group(*pid, GroupSignal::Kill);
            }
            self.forced = true;
        }
        let settle_at = when + TERMINATION_GRACE + FORCE_SETTLEMENT_GRACE;
        if !self.forced || self.public_settled || Instant::now() < settle_at {
            return;
        }
        let output = result(
            self.started,
            std::mem::take(&mut self.captured),
            None,
            self.stop,
            None,
        );
        if let Some(sender) = completion.take() {
            let _ = sender.send(output);
        }
        self.public_settled = true;
        for child in &mut self.children {
            let _ = child.start_kill();
        }
    }

    /// A failed wait leaves the pipeline unobservable: kill and reap
    /// everything and report the wait failure.
    async fn abandon(mut self, error: std::io::Error) -> StructuredCommandOutput {
        for pid in &self.pids {
            let _ = self.host.signal_group(*pid, GroupSignal::Kill);
        }
        for child in &mut self.children {
            let _ = child.start_kill();
            let _ = self.host.wait(child).await;
        }
        for task in self.io_tasks {
            task.abort();
            let _ = task.await;
        }
        result(
            self.started,
            self.captured,
            None,
            self.stop,
            Some(CommandError::new(
                CommandCode::CommandWaitFailed,
                error.to_string(),
            )),
        )
    }

    /// Joins the stream tasks (the last failure wins) and derives the exit
    /// code; an interrupted pipeline has none, a legacy one defaults to 1.
    async fn collect(self, dialect: Dialect) -> StructuredCommandOutput {
        let mut stream_error = None;
        for task in self.io_tasks {
            let failure = match task.await {
                Ok(Ok(())) => continue,
                Ok(Err(error)) => error.to_string(),
                Err(error) => error.to_string(),
            };
            stream_error = Some(CommandError::new(CommandCode::CommandStreamFailed, failure));
        }
        let exit = if self.stop.interrupted() {
            None
        } else {
            pipeline_exit(&self.statuses).or((dialect == Dialect::Legacy).then_some(1))
        };
        result(self.started, self.captured, exit, self.stop, stream_error)
    }
}
