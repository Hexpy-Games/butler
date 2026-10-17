//! Content-free workspace filesystem timings; disabled outside command diagnostics.
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub(super) struct Timing {
    started: Option<Instant>,
    phase: &'static str,
    id: u64,
}
impl Timing {
    pub(super) fn new(phase: &'static str) -> Self {
        use std::sync::atomic::AtomicU64;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let timing = Self {
            phase,
            id: NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            started: crate::btcc::agent_loop::command_timing::CommandTiming::enabled()
                .then(Instant::now),
        };
        timing.mark("entry");
        timing
    }
    pub(super) fn mark(&self, event: &'static str) {
        if let Some(started) = self.started {
            eprintln!(
                "command_file_timing phase={} id={} event={event} utc_us={} elapsed_us={}",
                self.phase,
                self.id,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_micros(),
                started.elapsed().as_micros()
            );
        }
    }
}
impl Drop for Timing {
    fn drop(&mut self) {
        self.mark("returned");
    }
}
