//! Process-wide, change-driven OS power notifications. No polling or restart loop.
use std::sync::OnceLock;
use tokio::sync::watch;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

fn events() -> &'static watch::Sender<u64> {
    static EVENTS: OnceLock<watch::Sender<u64>> = OnceLock::new();
    EVENTS.get_or_init(|| watch::channel(0).0)
}

#[cfg(any(
    target_os = "macos",
    target_os = "linux",
    windows,
    feature = "e2e-fixtures"
))]
fn emit() {
    events().send_modify(|counter| *counter = counter.wrapping_add(1));
}

/// Subscribe to power transitions. The OS watcher starts once, on first use.
/// Unavailable OS facilities produce one diagnostic and retain the fallback waits.
pub fn wake_events() -> watch::Receiver<u64> {
    static START: std::sync::Once = std::sync::Once::new();
    let receiver = events().subscribe();
    START.call_once(|| {
        #[cfg(target_os = "macos")]
        macos::start();
        #[cfg(target_os = "linux")]
        linux::start();
        #[cfg(windows)]
        windows::start();
    });
    receiver
}

/// Deliver a power notification through the same channel as the OS watcher.
#[cfg(feature = "e2e-fixtures")]
pub fn inject_wake() {
    emit();
}

/// Stop and reap the process-owned wake watcher before the host exits.
/// Platforms with an in-process OS subscription need no child cleanup.
pub fn close() -> impl std::future::Future<Output = ()> {
    #[cfg(target_os = "macos")]
    {
        macos::close()
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::future::ready(())
    }
}
