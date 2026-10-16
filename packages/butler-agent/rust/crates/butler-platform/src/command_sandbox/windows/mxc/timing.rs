//! Opt-in phase timings contain no command text, paths or environment values.
use std::time::Instant;

pub(super) struct Phase {
    name: &'static str,
    start: Option<Instant>,
}
impl Phase {
    pub(super) fn start(name: &'static str) -> Self {
        Self {
            name,
            start: (std::env::var("BUTLER_DEBUG_SANDBOX_TIMINGS").as_deref() == Ok("1"))
                .then(Instant::now),
        }
    }
}
impl Drop for Phase {
    fn drop(&mut self) {
        if let Some(start) = self.start {
            eprintln!(
                "command_sandbox_phase phase={} elapsed_us={}",
                self.name,
                start.elapsed().as_micros()
            );
        }
    }
}
