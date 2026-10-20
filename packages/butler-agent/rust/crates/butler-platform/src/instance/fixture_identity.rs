//! Feature-only cross-process barrier for an identity query racing process exit.

use super::IdentityError;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

/// Replace one completed native query with Unavailable after the driver has
/// observed the barrier and either kept the target alive or let it exit.
pub(super) fn probe<T>(
    pid: u32,
    operation: &str,
    result: Result<Option<T>, IdentityError>,
) -> Result<Option<T>, IdentityError> {
    let Some(root) = std::env::var_os("BUTLER_E2E_IDENTITY_BARRIER").map(PathBuf::from) else {
        return result;
    };
    let target = fs::read_to_string(root.join("target")).unwrap_or_default();
    let Some(skip) = target
        .strip_prefix(&format!("{pid}:{operation}:"))
        .and_then(|skip| skip.parse::<u32>().ok())
    else {
        return result;
    };
    static QUERIES: AtomicU32 = AtomicU32::new(0);
    if QUERIES.fetch_add(1, Ordering::Relaxed) < skip {
        return result;
    }
    let wait = || -> std::io::Result<()> {
        fs::write(root.join("reached"), b"native query completed")?;
        let deadline = Instant::now() + Duration::from_secs(30);
        while !root.join("release").exists() {
            if Instant::now() >= deadline {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "identity barrier",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    };
    let error = wait()
        .err()
        .unwrap_or_else(|| std::io::Error::other("identity query raced exit"));
    Err(IdentityError::Unavailable(Some(error)))
}
