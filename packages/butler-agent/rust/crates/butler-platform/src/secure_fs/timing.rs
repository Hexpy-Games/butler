//! Optional atomic-publication timings, without paths or file content.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub(super) struct Timing(Option<Box<Active>>);
struct Active {
    started: Instant,
    id: u64,
}

impl Timing {
    pub(super) fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let enabled = std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
            == Some(std::ffi::OsStr::new("1"));
        let timing = Self(enabled.then(|| {
            Box::new(Active {
                started: Instant::now(),
                id: NEXT.fetch_add(1, Ordering::Relaxed),
            })
        }));
        timing.mark("entry");
        timing
    }

    pub(super) fn mark(&self, event: &'static str) {
        if let Some(active) = &self.0 {
            let output = Instant::now();
            eprintln!(
                "command_file_timing phase=private_replace id={} event={event} utc_us={} elapsed_us={}",
                active.id,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_micros(),
                active.started.elapsed().as_micros()
            );
            if output.elapsed().as_millis() >= 1 {
                eprintln!(
                    "command_output_timing phase=private_replace duration_us={}",
                    output.elapsed().as_micros()
                );
            }
        }
    }
}

impl Drop for Timing {
    fn drop(&mut self) {
        self.mark("returned");
    }
}
