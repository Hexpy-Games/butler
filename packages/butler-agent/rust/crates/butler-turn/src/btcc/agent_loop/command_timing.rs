//! Opt-in, content-free timings for command execution diagnostics.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub(crate) struct CommandTiming {
    phase: &'static str,
    started: Option<Instant>,
    id: u64,
}

impl CommandTiming {
    pub(crate) fn new(phase: &'static str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let timing = Self {
            phase,
            started: (std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
                == Some(std::ffi::OsStr::new("1")))
            .then(Instant::now),
            id: NEXT.fetch_add(1, Ordering::Relaxed),
        };
        timing.mark("entry");
        timing
    }

    pub(crate) fn report_duration(
        phase: &'static str,
        event: &'static str,
        duration: std::time::Duration,
    ) {
        eprintln!(
            "command_duration_timing phase={phase} event={event} utc_us={} duration_us={}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_micros(),
            duration.as_micros()
        );
    }

    pub(crate) fn mark(&self, event: &'static str) {
        if let Some(started) = self.started {
            eprintln!(
                "command_phase_timing phase={} id={} event={} utc_us={} elapsed_us={}",
                self.phase,
                self.id,
                event,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_micros(),
                started.elapsed().as_micros()
            );
        }
    }
}

impl Drop for CommandTiming {
    fn drop(&mut self) {
        self.mark("returned");
    }
}
