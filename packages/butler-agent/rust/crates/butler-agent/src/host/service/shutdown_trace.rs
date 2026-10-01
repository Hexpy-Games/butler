//! Monotonic shutdown diagnostics for the debug stub E2E tier.
//! A begin without an end identifies the phase still pending at forced exit.

use std::{
    future::Future,
    sync::OnceLock,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(debug_assertions)]
static STOP_REQUESTED: OnceLock<Instant> = OnceLock::new();

pub(crate) fn event(phase: &str) {
    #[cfg(debug_assertions)]
    if phase == "stop_requested" && std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub") {
        let _ = STOP_REQUESTED.set(Instant::now());
    }
    emit(phase, "event");
}

#[cfg(debug_assertions)]
pub(crate) fn stop_elapsed() -> Option<std::time::Duration> {
    STOP_REQUESTED.get().map(Instant::elapsed)
}

fn emit(phase: &str, edge: &str) {
    if !cfg!(debug_assertions) || std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub") {
        return;
    }
    static STARTED: OnceLock<Instant> = OnceLock::new();
    let elapsed = STARTED.get_or_init(Instant::now).elapsed();
    let unix_us = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_micros());
    eprintln!(
        "[native-shutdown] unix_us={unix_us} elapsed_us={} phase={phase} edge={edge}",
        elapsed.as_micros()
    );
}

pub(crate) async fn measure<T>(phase: &str, work: impl Future<Output = T>) -> T {
    emit(phase, "begin");
    let result = work.await;
    emit(phase, "end");
    result
}
