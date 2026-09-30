//! Probe for an unused local port, for fixtures that need a closed endpoint.

use crate::e2e::{HarnessError, harness_error};

/// An unused port for closed-endpoint fixtures. This probe does not reserve it.
/// Agents bind port 0 themselves and publish the OS-assigned endpoint instead.
pub fn free_port() -> Result<u16, HarnessError> {
    use std::sync::atomic::{AtomicU32, Ordering};
    const FIRST: u32 = 20_000;
    const SPAN: u32 = 12_000;
    static NEXT: AtomicU32 = AtomicU32::new(u32::MAX);
    let _ = NEXT.compare_exchange(
        u32::MAX,
        (std::process::id() % 60) * 200,
        Ordering::Relaxed,
        Ordering::Relaxed,
    );
    for _ in 0..SPAN {
        let offset = NEXT.fetch_add(1, Ordering::Relaxed) % SPAN;
        let port =
            u16::try_from(FIRST + offset).map_err(|_| harness_error("free port out of range"))?;
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    Err(harness_error("no free port below the ephemeral range"))
}
