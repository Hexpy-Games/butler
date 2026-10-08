//! Stub-only, one-shot failure points for real filesystem E2E requests.

use std::{
    fs::File,
    io::{self, Write},
};

/// Writes one buffer, then injects a failure at `point` in explicitly selected stub tests.
pub fn write(file: &mut File, bytes: &[u8], point: &str) -> io::Result<()> {
    file.write_all(bytes)?;
    checkpoint(point)
}

/// Returns a one-shot I/O error when the harness selects `point` and a fresh
/// marker path. Ordinary runs never enable an injection.
pub fn checkpoint(point: &str) -> io::Result<()> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
        && std::env::var("BUTLER_E2E_FILE_FAULT").as_deref() == Ok(point)
        && let Some(marker) = std::env::var_os("BUTLER_E2E_FILE_FAULT_MARKER")
        && File::create_new(marker).is_ok()
    {
        return Err(io::Error::other("injected file replacement interruption"));
    }
    Ok(())
}

/// Debug-only process interruption at an explicitly selected correction boundary.
pub fn abort_point(point: &str) {
    #[cfg(debug_assertions)]
    if matches!(
        std::env::var("BUTLER_E2E_TIER").as_deref(),
        Ok("stub" | "perf")
    ) && std::env::var("BUTLER_E2E_ABORT_POINT").as_deref() == Ok(point)
    {
        std::process::abort();
    }
    #[cfg(not(debug_assertions))]
    let _ = point;
}
