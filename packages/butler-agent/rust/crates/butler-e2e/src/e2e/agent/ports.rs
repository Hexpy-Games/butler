//! Gateway port pairs held across startup, shutdown and restart.
use crate::e2e::{HarnessError, harness_error};
use butler_platform::instance::{InstanceLock, LockError};
use std::{
    fs::OpenOptions,
    sync::atomic::{AtomicU32, Ordering},
};

const FIRST: u32 = 20_000;
const SPAN: u32 = 12_000;
static NEXT: AtomicU32 = AtomicU32::new(u32::MAX);

fn candidate() -> Result<u16, HarnessError> {
    let _ = NEXT.compare_exchange(
        u32::MAX,
        (std::process::id() % 60) * 200,
        Ordering::Relaxed,
        Ordering::Relaxed,
    );
    let offset = NEXT.fetch_add(2, Ordering::Relaxed) % SPAN;
    u16::try_from(FIRST + offset).map_err(|_| harness_error("free port out of range"))
}

fn available(port: u16) -> bool {
    if let Ok(_primary) = std::net::TcpListener::bind(("127.0.0.1", port)) {
        std::net::TcpListener::bind(("127.0.0.1", port + 1)).is_ok()
    } else {
        false
    }
}

/// An unused port for closed-endpoint fixtures. This probe does not reserve it.
pub fn free_port() -> Result<u16, HarnessError> {
    for _ in 0..SPAN {
        let port = candidate()?;
        if available(port) {
            return Ok(port);
        }
    }
    Err(harness_error("no free port below the ephemeral range"))
}

/// The file lock coordinates separate nextest processes and stays held while
/// an Agent restarts. Socket probes alone leave both gaps unprotected.
pub(super) fn reserve() -> Result<(u16, InstanceLock), HarnessError> {
    let root = std::env::temp_dir().join("butler-e2e/port-pairs");
    std::fs::create_dir_all(&root)?;
    for _ in 0..SPAN {
        let port = candidate()?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join(format!("{port}.lock")))?;
        let lease = match InstanceLock::try_exclusive(file) {
            Ok(lease) => lease,
            Err(LockError::Busy) => continue,
            Err(error) => return Err(harness_error(error.to_string())),
        };
        if available(port) {
            return Ok((port, lease));
        }
    }
    Err(harness_error("no unreserved gateway port pair"))
}
