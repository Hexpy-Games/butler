//! Opt-in monotonic phase timing for isolated stub/perf startup reviews.
use std::time::Instant;

pub(in crate::host) struct Trace {
    started: Instant,
    previous: Instant,
    enabled: bool,
}

impl Trace {
    pub(in crate::host) fn new() -> Self {
        let started = Instant::now();
        Self {
            started,
            previous: started,
            enabled: std::env::var("BUTLER_STARTUP_TRACE").as_deref() == Ok("1"),
        }
    }

    /// Sub-phases measured on another thread; totals keep the outer start.
    pub(in crate::host) fn nested(&self) -> Self {
        Self {
            started: self.started,
            previous: Instant::now(),
            enabled: self.enabled,
        }
    }

    pub(in crate::host) fn phase(&mut self, phase: &str) {
        let now = Instant::now();
        if self.enabled {
            butler_core::diagnostic!(
                "[native-startup] phase={phase} duration_us={} total_us={}",
                now.duration_since(self.previous).as_micros(),
                now.duration_since(self.started).as_micros()
            );
        }
        self.previous = now;
    }
}

/// In-process storage timing survives removal of the external progress sidecar.
#[derive(Clone, Copy)]
pub(crate) enum Correction {
    Pending,
    Validating(Instant),
    Running(Instant),
    Finished(Instant),
}

pub(crate) type CorrectionSender = tokio::sync::watch::Sender<Correction>;

pub(crate) type AppStartup<'a> = (
    std::sync::Arc<crate::host::app::gateway_lifecycle::ActiveAppEndpoint>,
    &'a tokio_util::sync::CancellationToken,
    CorrectionSender,
);
