//! Recoverable command loop: each drained record batch shares ERROR durability.
use super::*;
use std::time::{Duration, Instant};

#[derive(Default)]
struct State {
    flush_at: Option<Instant>,
    full_until: Option<Instant>,
    previous: Preset,
    error: Option<io::Error>,
}
impl State {
    fn report(&mut self, result: io::Result<()>) {
        if let Err(error) = result {
            eprintln!("structured log writer I/O failure: {error}");
            self.error.get_or_insert(error);
        }
    }
}
impl Logger {
    pub(super) fn run(&self, rx: &mpsc::Receiver<Command>) -> io::Result<()> {
        let mut state = State::default();
        let mut pending = None;
        loop {
            let deadline = [state.flush_at, state.full_until]
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
            if let Command::Record(..) = command {
                pending = self.batch(command, rx, &mut state);
            } else if let Command::Control(command) = command
                && self.control(command, &mut state)
            {
                return Ok(());
            }
        }
        self.0.storage.lock().close()
    }
    fn timers(&self, state: &mut State) {
        if state.full_until.is_some_and(|d| Instant::now() >= d) {
            let mut config = self.config().effective;
            config.level = state.previous.clone();
            state.report(self.apply(config).map(|_| ()));
            state.full_until = None;
        }
        if state.flush_at.is_some_and(|d| Instant::now() >= d) {
            state.report(self.0.storage.lock().flush(false));
            state.flush_at = None;
        }
    }
    fn batch(
        &self,
        first: Command,
        rx: &mpsc::Receiver<Command>,
        state: &mut State,
    ) -> Option<Command> {
        let mut sync = false;
        let mut pending = Some(first);
        for _ in 0..1024 {
            let Some(command) = pending.take() else {
                break;
            };
            let Command::Record(row, lossy, bytes) = command else {
                pending = Some(command);
                break;
            };
            self.0.queued_bytes.fetch_sub(bytes, Ordering::Relaxed);
            sync |= row.level.eq_ignore_ascii_case("ERROR");
            state.report(self.write_queued(*row, lossy));
            pending = rx.try_recv().ok();
        }
        if sync {
            state.report(self.0.storage.lock().flush(true));
        }
        state
            .flush_at
            .get_or_insert_with(|| Instant::now() + Duration::from_secs(1));
        pending
    }
    fn control(&self, command: Control, state: &mut State) -> bool {
        match command {
            Control::Configure(config, reply) => {
                let full = config.level == Preset::Full;
                let previous = self.config().effective.level;
                let result = self.apply(config);
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
            Control::Flush(reply) => {
                let result = self.0.storage.lock().flush(false);
                let _ = reply.send(state.error.take().map_or(result, Err));
                state.flush_at = None;
            }
            Control::Clear(reply) => {
                let _ = reply.send(self.0.storage.lock().clear());
                state.flush_at = None;
            }
            Control::Shutdown(reply) => {
                let result = self.0.storage.lock().close();
                let _ = reply.send(state.error.take().map_or(result, Err));
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
}
