//! Recoverable command loop: each drained record batch shares ERROR durability.
use super::*;
use std::time::{Duration, Instant};

#[derive(Default)]
struct State {
    full_until: Option<Instant>,
    previous: Preset,
    cleanup_at: Option<Instant>,
    cleanup_backoff: Duration,
}
impl Logger {
    pub(super) fn run(&self, rx: &mpsc::Receiver<Command>) -> io::Result<()> {
        let mut state = State::default();
        self.schedule_cleanup(&mut state);
        let mut pending = None;
        loop {
            let deadline = [state.full_until, state.cleanup_at]
                .into_iter()
                .flatten()
                .min();
            let received = if let Some(command) = pending.take() {
                Ok(command)
            } else if let Some(deadline) = deadline {
                rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            } else {
                rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected)
            };
            self.timers(&mut state);
            let command = match received {
                Ok(command) => command,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            if let Command::Dropped = command {
                self.report(self.report_drops());
                self.report(self.0.storage.lock().flush(false));
            } else if matches!(command, Command::Record(..) | Command::Deferred(..)) {
                pending = self.batch(command, rx);
            } else if let Command::Control(command) = command
                && self.control(command, &mut state)
            {
                return Ok(());
            }
        }
        self.0.storage.lock().close()
    }
    fn report(&self, result: io::Result<()>) {
        if let Err(error) = result {
            self.report_error(&error);
        }
    }
    fn schedule_cleanup(&self, state: &mut State) {
        if self.0.storage.lock().cleanup_pending() {
            state.cleanup_backoff = state.cleanup_backoff.max(Duration::from_secs(1));
            state
                .cleanup_at
                .get_or_insert_with(|| Instant::now() + state.cleanup_backoff);
        } else {
            state.cleanup_at = None;
            state.cleanup_backoff = Duration::ZERO;
        }
    }
    fn timers(&self, state: &mut State) {
        if state.full_until.is_some_and(|d| Instant::now() >= d) {
            let mut config = self.config().effective;
            config.level = state.previous.clone();
            self.report(self.apply(config).map(|_| ()));
            state.full_until = None;
        }
        if state.cleanup_at.is_some_and(|d| Instant::now() >= d) {
            let result = self.0.storage.lock().cleanup();
            if let Err(error) = result {
                let next = (state.cleanup_backoff * 2)
                    .clamp(Duration::from_secs(1), Duration::from_secs(600));
                if next != state.cleanup_backoff {
                    self.report_error(&error);
                }
                state.cleanup_backoff = next;
            }
            state.cleanup_at = None;
        }
        self.schedule_cleanup(state);
    }
    fn batch(&self, first: Command, rx: &mpsc::Receiver<Command>) -> Option<Command> {
        let mut sync = false;
        let mut acknowledgements = Vec::new();
        let mut pending = Some(first);
        for _ in 0..1024 {
            let Some(command) = pending.take() else {
                break;
            };
            let (row, lossy, bytes, ack) = match command {
                Command::Record(row, lossy, bytes, ack) => (row, lossy, bytes, ack),
                Command::Deferred(make, bytes) => {
                    let row = Encoded::new(make(), &self.snapshot().effective);
                    self.0.deferred.fetch_sub(bytes, Ordering::Relaxed);
                    match row {
                        Ok(row) => (row, false, 0, None),
                        Err(error) => {
                            self.report_error(&error);
                            pending = rx.try_recv().ok();
                            continue;
                        }
                    }
                }
                command => {
                    pending = Some(command);
                    break;
                }
            };
            if !lossy {
                self.0.queue.bytes.fetch_sub(bytes, Ordering::Relaxed);
            }
            sync |= row.level.eq_ignore_ascii_case("ERROR");
            match self.write_queued(row, lossy) {
                Ok(()) => acknowledgements.extend(ack),
                Err(error) => {
                    self.report_error(&error);
                    if let Some(ack) = ack {
                        let _ = ack.send(Err(error));
                    }
                }
            }
            pending = rx.try_recv().ok();
        }
        // Coalesce only records already queued. Never leave a partial buffer
        // waiting for a timer after the producer has become idle.
        let result = self.0.storage.lock().flush(false);
        for ack in acknowledgements {
            let reply = result
                .as_ref()
                .copied()
                .map_err(|e| io::Error::new(e.kind(), e.to_string()));
            let _ = ack.send(reply);
        }
        self.report(result);
        if sync {
            self.report(self.0.storage.lock().flush(true));
        }
        pending
    }
    fn control(&self, command: Control, state: &mut State) -> bool {
        match command {
            Control::Configure(config, reply) => {
                let full = config.level == Preset::Full;
                let previous = self.config().effective.level;
                let result = self.apply(config);
                self.schedule_cleanup(state);
                if result.is_ok() {
                    if full && state.full_until.is_none() {
                        state.previous = previous;
                        state.full_until = Some(Instant::now() + Duration::from_secs(3600));
                    } else if !full {
                        state.full_until = None;
                    }
                }
                let _ = reply.send(result);
            }
            #[cfg(feature = "e2e-fixtures")]
            Control::Pause(resume, reply) => {
                let _ = reply.send(Ok(()));
                let _ = resume.lock().recv();
            }
            Control::Flush(reply) => {
                let result = self.0.storage.lock().flush(false);
                let _ = reply.send(result);
            }
            Control::Clear(reply) => {
                let _ = reply.send(self.0.storage.lock().clear());
            }
            Control::Shutdown(reply) => {
                let result = self.close();
                let _ = reply.send(result);
                return true;
            }
            Control::ShutdownBounded(reply) => {
                let _ = reply.send(self.close());
                return true;
            }
            #[cfg(feature = "e2e-fixtures")]
            Control::Expire(reply) => {
                state.full_until = Some(Instant::now());
                let _ = reply.send(Ok(()));
            }
            #[cfg(feature = "e2e-fixtures")]
            Control::SyncCount(reply) => {
                let _ = reply.send(Ok(super::super::files::sync_count()));
            }
            #[cfg(feature = "e2e-fixtures")]
            Control::Prune(reply) => {
                let _ = reply.send(self.0.storage.lock().prune());
            }
        }
        false
    }
    fn close(&self) -> io::Result<()> {
        #[cfg(feature = "e2e-fixtures")]
        close_delay();
        self.0.storage.lock().close()
    }
}

/// Model a stuck close without blocking a Tokio worker or changing shipped builds.
#[cfg(feature = "e2e-fixtures")]
fn close_delay() {
    if let Some(delay) = std::env::var("BUTLER_E2E_LOG_CLOSE_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    {
        std::thread::sleep(Duration::from_millis(delay));
    }
}
