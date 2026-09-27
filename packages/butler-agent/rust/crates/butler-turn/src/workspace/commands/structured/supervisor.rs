//! Supervision of a running structured pipeline until it settles.

use super::*;

/// The external events that stop a running pipeline.
pub(super) struct Signals<'a> {
    pub(super) deadline: Instant,
    pub(super) abort: &'a CancellationToken,
    pub(super) shutdown: &'a CancellationToken,
}

/// Owns a running pipeline until every step is reaped and every stream task
/// finished, even after the public result was settled early.
pub(super) struct Supervisor<'a> {
    pub(super) host: &'a dyn ProcessHost,
    pub(super) children: Vec<Child>,
    pub(super) pids: Vec<u32>,
    pub(super) statuses: Vec<Option<ExitStatus>>,
    pub(super) io_tasks: Vec<IoTask>,
    pub(super) decoders: Decoders,
    pub(super) captured: Captured,
    pub(super) stop: Stop,
    pub(super) closing: bool,
    pub(super) first_termination: Option<Instant>,
    pub(super) forced: bool,
    pub(super) public_settled: bool,
    pub(super) started: SystemTime,
}

impl Supervisor<'_> {
    pub(super) async fn supervise(
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
                    self.receive(chunk, completion);
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
    pub(super) fn reap_exited(&mut self) -> std::io::Result<()> {
        for (child, status) in self.children.iter_mut().zip(&mut self.statuses) {
            if status.is_none() {
                *status = self.host.try_wait(child)?;
            }
        }
        Ok(())
    }

    pub(super) fn settled(&self) -> bool {
        self.statuses.iter().all(Option::is_some)
            && self.decoders.done
            && self.io_tasks.iter().all(JoinHandle::is_finished)
    }

    /// Output after the result was settled early is dropped.
    pub(super) fn receive(&mut self, chunk: Option<StreamChunk>, completion: &Completion) {
        match chunk {
            Some(chunk) if completion.is_some() => {
                self.decoders.decode(&chunk, &mut self.captured);
            }
            Some(_) => {}
            None => self.decoders.done = true,
        }
    }

    pub(super) fn request_termination(&mut self) {
        for pid in &self.pids {
            let _ = self.host.signal_group(*pid, GroupSignal::Terminate);
        }
        if self.first_termination.is_none() {
            self.first_termination = Some(Instant::now());
        }
    }

    /// Kills the groups once the termination grace passed and, after the force
    /// grace, settles the public result while the owner keeps reaping.
    pub(super) fn enforce_grace(&mut self, completion: &mut Completion) {
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
    pub(super) async fn abandon(mut self, error: std::io::Error) -> StructuredCommandOutput {
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
    pub(super) async fn collect(self, dialect: Dialect) -> StructuredCommandOutput {
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
