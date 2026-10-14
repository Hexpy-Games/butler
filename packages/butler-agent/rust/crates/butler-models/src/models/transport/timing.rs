//! Content-free HTTP/SSE probes under the command diagnostic switch.
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub(super) struct Timing(Option<Instant>);
impl Timing {
    pub(super) fn new() -> Self {
        let timing = Self(
            (std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
                == Some(std::ffi::OsStr::new("1")))
            .then(Instant::now),
        );
        timing.mark("entry");
        timing
    }
    pub(super) fn mark(&self, event: &'static str) {
        if let Some(started) = self.0 {
            eprintln!(
                "command_transport_timing event={event} utc_us={} elapsed_us={}",
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
