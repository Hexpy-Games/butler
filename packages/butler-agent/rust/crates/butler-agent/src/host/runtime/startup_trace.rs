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

impl Correction {
    pub(crate) fn deadline(self, original: Instant) -> Instant {
        use crate::host::service::entrypoint::STARTUP_TIMEOUT;
        let grace = std::time::Duration::from_secs(180) + STARTUP_TIMEOUT;
        let (deadline, budget, state) = match self {
            Self::Pending => (original, STARTUP_TIMEOUT, "pending"),
            Self::Validating(start) => (start + grace, grace, "validating"),
            Self::Running(start) => (start + grace, grace, "correcting"),
            Self::Finished(end) => (
                original.max(end + STARTUP_TIMEOUT),
                STARTUP_TIMEOUT,
                "finished",
            ),
        };
        if std::env::var("BUTLER_STARTUP_TRACE").as_deref() == Ok("1") {
            butler_core::diagnostic!(
                "[native-startup] phase=readiness state={state} budget_ms={}",
                budget.as_millis()
            );
        }
        deadline
    }

    pub(crate) fn publish(self, timing: &CorrectionSender) {
        // Trace every transition even when the watch receiver coalesces updates.
        self.deadline(Instant::now() + crate::host::service::entrypoint::STARTUP_TIMEOUT);
        timing.send_replace(self);
    }
}

pub(crate) type CorrectionSender = tokio::sync::watch::Sender<Correction>;

pub(crate) type AppStartup<'a> = (
    std::sync::Arc<crate::host::app::gateway_lifecycle::ActiveAppEndpoint>,
    &'a tokio_util::sync::CancellationToken,
    CorrectionSender,
);
