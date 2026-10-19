//! E2E fixture failure points for real filesystem requests. Without the
//! `e2e-fixtures` feature every point is inert.

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
    #[cfg(feature = "e2e-fixtures")]
    if std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
        && std::env::var("BUTLER_E2E_FILE_FAULT").as_deref() == Ok(point)
        && let Some(marker) = std::env::var_os("BUTLER_E2E_FILE_FAULT_MARKER")
        && File::create_new(marker).is_ok()
    {
        return Err(io::Error::other("injected file replacement interruption"));
    }
    #[cfg(not(feature = "e2e-fixtures"))]
    let _ = point;
    Ok(())
}

/// Fixture-only process interruption at an explicitly selected correction boundary.
pub fn abort_point(point: &str) {
    #[cfg(feature = "e2e-fixtures")]
    if matches!(
        std::env::var("BUTLER_E2E_TIER").as_deref(),
        Ok("stub" | "perf")
    ) && std::env::var("BUTLER_E2E_ABORT_POINT").as_deref() == Ok(point)
    {
        std::process::abort();
    }
    #[cfg(not(feature = "e2e-fixtures"))]
    let _ = point;
}

/// Fixture-only storage pause, bounded by the caller's stop token and deadline.
pub fn hold_point(point: &str, stopped: impl Fn() -> bool) -> io::Result<()> {
    #[cfg(feature = "e2e-fixtures")]
    if std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
        && std::env::var("BUTLER_E2E_HOLD_POINT").as_deref() == Ok(point)
        && let Some(release) = std::env::var_os("BUTLER_E2E_HOLD_RELEASE")
    {
        let release = std::path::PathBuf::from(release);
        match File::create_new(release.with_extension("held")) {
            Ok(file) => drop(file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        while !release.exists() && !stopped() {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    #[cfg(not(feature = "e2e-fixtures"))]
    let _ = (point, stopped);
    Ok(())
}
