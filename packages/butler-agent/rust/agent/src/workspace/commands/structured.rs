use std::process::Stdio;
use std::time::{Duration, SystemTime};

use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::decode::Utf8Decoder;
use super::process::{FORCE_SETTLEMENT_GRACE, ProcessHost, TERMINATION_GRACE};
use super::{CommandError, StructuredCommandInput, StructuredCommandOutput};

mod invocation;
mod result;
mod streams;
use invocation::{environment, invocation_steps};
use result::{bounded_timeout, pipeline_exit, result};
use streams::{StreamChunk, StreamKind, read_stream};

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

async fn execute(
    host: &dyn ProcessHost,
    input: StructuredCommandInput,
    shutdown: CancellationToken,
    completion: &mut Option<oneshot::Sender<StructuredCommandOutput>>,
) -> StructuredCommandOutput {
    let started = SystemTime::now();
    if input.abort.is_cancelled() {
        return result(
            started,
            String::new(),
            String::new(),
            None,
            false,
            true,
            None,
        );
    }
    #[cfg(windows)]
    return result(
        started,
        String::new(),
        String::new(),
        None,
        false,
        false,
        Some(CommandError::new(
            "command_platform_unavailable",
            "Native structured command containment is unavailable on this host",
        )),
    );
    let legacy = input.legacy.is_some();
    let steps = match invocation_steps(&input) {
        Ok(steps) => steps,
        Err(error) if error.code == "legacy_command_empty" => {
            return result(
                started,
                String::new(),
                format!("{}\n", error.message),
                Some(64),
                false,
                false,
                None,
            );
        }
        Err(error) => {
            return result(
                started,
                String::new(),
                String::new(),
                None,
                false,
                false,
                Some(error),
            );
        }
    };
    if steps.is_empty() {
        return result(
            started,
            String::new(),
            String::new(),
            None,
            false,
            false,
            Some(CommandError::new(
                "command_plan_empty",
                "command plan must contain at least one executable step",
            )),
        );
    }
    let environment = environment(&input);
    let mut children = Vec::with_capacity(steps.len());
    let mut pids = Vec::with_capacity(steps.len());
    let mut stdio = Vec::with_capacity(steps.len());
    for step in &steps {
        let mut command = Command::new(&step.executable);
        command
            .args(&step.arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear()
            .envs(&environment)
            .kill_on_drop(true);
        if let Some(cwd) = &input.cwd {
            command.current_dir(cwd);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        let spawned = host.spawn(&mut command).await.and_then(|mut child| {
            let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
            match (child.id(), pipes) {
                (Some(pid), (Some(stdin), Some(stdout), Some(stderr))) => {
                    Ok((child, pid, (stdin, stdout, stderr)))
                }
                _ => Err(std::io::Error::other(
                    "spawned command has no pid or piped stdio",
                )),
            }
        });
        match spawned {
            Ok((child, pid, pipes)) => {
                pids.push(pid);
                children.push(child);
                stdio.push(pipes);
            }
            Err(spawn_error) => {
                let mut cleanup_error = None;
                for child in &mut children {
                    if let Err(error) = super::process::terminate_and_reap(host, child).await
                        && cleanup_error.is_none()
                    {
                        cleanup_error = Some(error);
                    }
                }
                if let Some(error) = cleanup_error {
                    return result(
                        started,
                        String::new(),
                        String::new(),
                        None,
                        false,
                        false,
                        Some(error),
                    );
                }
                let mut error = if legacy {
                    CommandError::new(
                        "legacy_shell_spawn_failed",
                        "legacy command compatibility process could not be started",
                    )
                } else {
                    CommandError::new(
                        "command_spawn_failed",
                        "command process could not be started",
                    )
                };
                error.io_kind = Some(spawn_error.kind());
                let stderr = if legacy {
                    format!("{}\n", error.message)
                } else {
                    String::new()
                };
                let exit = if legacy { Some(127) } else { None };
                return result(
                    started,
                    String::new(),
                    stderr,
                    exit,
                    false,
                    false,
                    if legacy { None } else { Some(error) },
                );
            }
        }
    }
    let (tx, mut rx) = mpsc::channel::<StreamChunk>(64);
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
    // The plan was checked to be non-empty, so the pipeline has both ends.
    let mut stdins = stdins.into_iter();
    let (Some(mut first_stdin), Some(last_stdout)) = (stdins.next(), stdouts.pop()) else {
        return result(
            started,
            String::new(),
            String::new(),
            None,
            false,
            false,
            Some(CommandError::new(
                "command_plan_empty",
                "command plan must contain at least one executable step",
            )),
        );
    };
    io_tasks.push(tokio::spawn(read_stream(
        last_stdout,
        StreamKind::Stdout,
        tx.clone(),
    )));
    drop(tx);
    // Each step's stdout feeds the next step's stdin.
    for (mut stdout, mut stdin) in stdouts.into_iter().zip(stdins) {
        io_tasks.push(tokio::spawn(async move {
            let copied = tokio::io::copy(&mut stdout, &mut stdin).await;
            drop(stdin);
            copied.map(|_| ())
        }));
    }
    let stdin_bytes = input.stdin.into_bytes();
    io_tasks.push(tokio::spawn(async move {
        let result = first_stdin.write_all(&stdin_bytes).await;
        drop(first_stdin);
        result
    }));

    let timeout = bounded_timeout(input.timeout_ms);
    let deadline = tokio::time::Instant::now() + timeout;
    let mut timeout_fired = false;
    let mut cancelled = false;
    let mut closing = false;
    let mut first_termination: Option<tokio::time::Instant> = None;
    let mut forced = false;
    let mut statuses = vec![None; children.len()];
    let mut stdout_text = String::new();
    let mut stderr_text = String::new();
    let mut stdout_decoder = Utf8Decoder::default();
    let mut stderr_decoders: Vec<_> = (0..children.len())
        .map(|_| Utf8Decoder::default())
        .collect();
    let mut streams_done = false;
    let mut public_settled = false;
    loop {
        for index in 0..children.len() {
            if statuses[index].is_none() {
                match host.try_wait(&mut children[index]) {
                    Ok(Some(status)) => statuses[index] = Some(status),
                    Ok(None) => {}
                    Err(error) => {
                        for pid in &pids {
                            let _ = host.signal_group(*pid, true);
                        }
                        for child in &mut children {
                            let _ = child.start_kill();
                            let _ = host.wait(child).await;
                        }
                        for task in io_tasks {
                            task.abort();
                            let _ = task.await;
                        }
                        return result(
                            started,
                            stdout_text,
                            stderr_text,
                            None,
                            timeout_fired,
                            cancelled,
                            Some(CommandError::new("command_wait_failed", error.to_string())),
                        );
                    }
                }
            }
        }
        let all_reaped = statuses.iter().all(Option::is_some);
        if all_reaped && streams_done && io_tasks.iter().all(tokio::task::JoinHandle::is_finished) {
            break;
        }
        tokio::select! {
            chunk = rx.recv(), if !streams_done => {
                match chunk {
                    Some(chunk) if completion.is_some() => match chunk.kind {
                        StreamKind::Stdout => if chunk.end { stdout_decoder.end(&mut stdout_text); }
                            else { stdout_decoder.write(&chunk.bytes, &mut stdout_text); },
                        StreamKind::Stderr(index) => if chunk.end { stderr_decoders[index].end(&mut stderr_text); }
                            else { stderr_decoders[index].write(&chunk.bytes, &mut stderr_text); },
                    },
                    Some(_) => {},
                    None => streams_done = true,
                }
            }
            _ = tokio::time::sleep_until(deadline), if !timeout_fired => {
                timeout_fired = true;
                request_termination(host, &pids, &mut first_termination);
            }
            _ = input.abort.cancelled(), if !cancelled => {
                cancelled = true;
                request_termination(host, &pids, &mut first_termination);
            }
            _ = shutdown.cancelled(), if !closing => {
                cancelled = true;
                closing = true;
                request_termination(host, &pids, &mut first_termination);
            }
            _ = tokio::time::sleep(Duration::from_millis(10)) => {},
        }
        if let Some(when) = first_termination {
            if !forced && tokio::time::Instant::now() >= when + TERMINATION_GRACE {
                for pid in &pids {
                    let _ = host.signal_group(*pid, true);
                }
                forced = true;
            }
            if forced
                && !public_settled
                && tokio::time::Instant::now() >= when + TERMINATION_GRACE + FORCE_SETTLEMENT_GRACE
            {
                let output = result(
                    started,
                    std::mem::take(&mut stdout_text),
                    std::mem::take(&mut stderr_text),
                    None,
                    timeout_fired,
                    cancelled,
                    None,
                );
                if let Some(sender) = completion.take() {
                    let _ = sender.send(output);
                }
                public_settled = true;
                // The owner stays active until every child is reaped.
                for child in &mut children {
                    let _ = child.start_kill();
                }
            }
        }
    }
    let mut stream_error = None;
    for task in io_tasks {
        match task.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                stream_error = Some(CommandError::new(
                    "command_stream_failed",
                    error.to_string(),
                ))
            }
            Err(error) => {
                stream_error = Some(CommandError::new(
                    "command_stream_failed",
                    error.to_string(),
                ))
            }
        }
    }
    let exit = if timeout_fired || cancelled {
        None
    } else {
        pipeline_exit(&statuses)
    };
    let exit = if legacy && !timeout_fired && !cancelled && exit.is_none() {
        Some(1)
    } else {
        exit
    };
    result(
        started,
        stdout_text,
        stderr_text,
        exit,
        timeout_fired,
        cancelled,
        stream_error,
    )
}

fn request_termination(
    host: &dyn ProcessHost,
    pids: &[u32],
    first: &mut Option<tokio::time::Instant>,
) {
    for pid in pids {
        let _ = host.signal_group(*pid, false);
    }
    if first.is_none() {
        *first = Some(tokio::time::Instant::now());
    }
}
