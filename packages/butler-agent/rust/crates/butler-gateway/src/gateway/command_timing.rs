//! Opt-in, content-free gateway spans for approval and publication diagnostics.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub(crate) struct CommandTiming(Option<Box<Span>>);

struct Span {
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

    pub(crate) fn report_duration(
        phase: &'static str,
        event: &'static str,
        elapsed: std::time::Duration,
    ) {
        if !Self::enabled() {
            return;
        }
        butler_platform::stdio::diagnostic_line(format_args!(
            "command_gateway_duration_timing phase={phase} event={event} utc_us={} duration_us={}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_micros(),
            elapsed.as_micros()
        ));
    }

    pub(crate) fn new(phase: &'static str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let enabled = Self::enabled();
        let timing = Self(enabled.then(|| {
            Box::new(Span {
                phase,
                started: Instant::now(),
                id: NEXT.fetch_add(1, Ordering::Relaxed),
            })
        }));
        timing.mark("entry");
        timing
    }

    pub(crate) fn mark(&self, event: &'static str) {
        if let Some(span) = &self.0 {
            let output = Instant::now();
            butler_platform::stdio::diagnostic_line(format_args!(
                "command_gateway_timing phase={} id={} event={} utc_us={} elapsed_us={}",
                span.phase,
                span.id,
                event,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_micros(),
                span.started.elapsed().as_micros()
            ));
            if output.elapsed().as_millis() >= 1 {
                butler_platform::stdio::diagnostic_line(format_args!(
                    "command_output_timing phase={} duration_us={}",
                    span.phase,
                    output.elapsed().as_micros()
                ));
            }
        }
    }
}

impl Drop for CommandTiming {
    fn drop(&mut self) {
        self.mark("returned");
    }
}
