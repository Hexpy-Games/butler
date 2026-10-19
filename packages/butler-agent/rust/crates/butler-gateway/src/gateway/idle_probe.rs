//! Content-free source-open counter for the isolated idle E2E; it counts
//! only in E2E fixture builds.
#[cfg(feature = "e2e-fixtures")]
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(feature = "e2e-fixtures")]
static ENABLED: OnceLock<bool> = OnceLock::new();
static TRANSCRIPT_OPENS: AtomicU64 = AtomicU64::new(0);

#[cfg(not(feature = "e2e-fixtures"))]
fn enabled() -> bool {
    false
}

#[cfg(feature = "e2e-fixtures")]
fn enabled() -> bool {
    *ENABLED.get_or_init(crate::gateway::faults::idle_probe)
}

pub(super) fn transcript_open() {
    if enabled() {
        TRANSCRIPT_OPENS.fetch_add(1, Ordering::Relaxed);
    }
}

pub(super) fn transcript_opens() -> Option<u64> {
    enabled().then(|| TRANSCRIPT_OPENS.load(Ordering::Relaxed))
}
