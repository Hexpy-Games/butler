//! Opt-in, content-free source-open counter for the isolated idle E2E.
use std::sync::{
    OnceLock,
    atomic::{AtomicU64, Ordering},
};

static ENABLED: OnceLock<bool> = OnceLock::new();
static TRANSCRIPT_OPENS: AtomicU64 = AtomicU64::new(0);

fn enabled() -> bool {
    *ENABLED.get_or_init(|| {
        std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
            && std::env::var("BUTLER_E2E_IDLE_PROBE").as_deref() == Ok("1")
    })
}

pub(super) fn transcript_open() {
    if enabled() {
        TRANSCRIPT_OPENS.fetch_add(1, Ordering::Relaxed);
    }
}

pub(super) fn transcript_opens() -> Option<u64> {
    enabled().then(|| TRANSCRIPT_OPENS.load(Ordering::Relaxed))
}
