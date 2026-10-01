//! Debug stub diagnostics for App owner shutdown phases.

use std::{
    future::Future,
    sync::OnceLock,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

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

/// Time synchronous work on an owner lane without moving it to a Tokio worker.
pub(crate) fn measure_sync<T>(phase: &str, work: impl FnOnce() -> T) -> T {
    emit(phase, "begin");
    let result = work();
    emit(phase, "end");
    result
}
