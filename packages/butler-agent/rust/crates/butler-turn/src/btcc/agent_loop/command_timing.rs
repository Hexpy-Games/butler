//! Opt-in, content-free timings for command execution diagnostics.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub(crate) struct CommandTiming(Option<Box<ActiveTiming>>);

struct ActiveTiming {
    phase: &'static str,
    started: Instant,
    id: u64,
}

impl CommandTiming {
    pub(crate) fn enabled() -> bool {
        static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *ENABLED.get_or_init(|| {
            std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
                == Some(std::ffi::OsStr::new("1"))
        })
    }

    pub(crate) fn new(phase: &'static str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let enabled = Self::enabled();
        let timing = Self(enabled.then(|| {
            Box::new(ActiveTiming {
                phase,
                started: Instant::now(),
                id: NEXT.fetch_add(1, Ordering::Relaxed),
            })
        }));
        timing.mark("entry");
        timing
    }

    pub(crate) fn report_duration(
        phase: &'static str,
        event: &'static str,
        duration: std::time::Duration,
    ) {
        let output_started = Instant::now();
        butler_platform::stdio::diagnostic_line(format_args!(
            "command_duration_timing phase={phase} event={event} utc_us={} duration_us={}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_micros(),
            duration.as_micros()
        ));
        report_output_wait(phase, output_started);
    }

    pub(crate) fn mark(&self, event: &'static str) {
        if let Some(timing) = &self.0 {
            let output_started = Instant::now();
            butler_platform::stdio::diagnostic_line(format_args!(
                "command_phase_timing phase={} id={} event={} utc_us={} elapsed_us={}",
                timing.phase,
                timing.id,
                event,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_micros(),
                timing.started.elapsed().as_micros()
            ));
            report_output_wait(timing.phase, output_started);
        }
    }
}

impl Drop for CommandTiming {
    fn drop(&mut self) {
        self.mark("returned");
    }
}

// A slow diagnostic write must not be mistaken for database or queue work.
// Emit only slow writes to avoid doubling ordinary statement diagnostics.
fn report_output_wait(phase: &'static str, started: Instant) {
    let duration = started.elapsed();
    if duration >= std::time::Duration::from_millis(1) {
        butler_platform::stdio::diagnostic_line(format_args!(
            "command_output_timing phase={phase} duration_us={}",
            duration.as_micros()
        ));
    }
}
