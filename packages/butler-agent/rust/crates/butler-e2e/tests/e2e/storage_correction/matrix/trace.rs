//! Timings survive nextest termination even when Agent drop diagnostics cannot run.
use butler_e2e::e2e::HarnessError;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub(super) async fn phase<T>(
    name: &str,
    work: impl std::future::Future<Output = Result<T, HarnessError>>,
) -> Result<T, HarnessError> {
    let started = Instant::now();
    let unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis());
    eprintln!("CORR-MATRIX phase={name} edge=begin unix_ms={unix_ms}");
    let result = work.await;
    eprintln!(
        "CORR-MATRIX phase={name} edge=end elapsed_ms={} ok={}",
        started.elapsed().as_millis(),
        result.is_ok()
    );
    result
}
