use std::{fs::File, io};
/// Returns a one-shot I/O error when the harness selects `point` and a fresh
/// marker path. Ordinary runs never enable an injection.
pub(crate) fn checkpoint(point: &str) -> io::Result<()> {
    if std::env::var("BUTLER_E2E_FILE_FAULT").as_deref() == Ok(point)
        && let Some(marker) = std::env::var_os("BUTLER_E2E_FILE_FAULT_MARKER")
        && File::create_new(marker).is_ok()
    {
        return Err(io::Error::other("injected file replacement interruption"));
    }
    Ok(())
}

/// Fixture-only process interruption at an explicitly selected correction boundary.
pub(crate) fn abort_point(point: &str) {
    if std::env::var("BUTLER_E2E_ABORT_POINT").as_deref() == Ok(point) {
        std::process::abort();
    }
}

/// Fixture-only storage pause, bounded by the caller's stop token and deadline.
pub(crate) fn hold_point(point: &str, stopped: impl Fn() -> bool) -> io::Result<()> {
    if std::env::var("BUTLER_E2E_HOLD_POINT").as_deref() == Ok(point)
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
    Ok(())
}

pub(crate) struct FixtureInput;
impl FixtureInput {
    pub(crate) fn available_bytes() -> Option<io::Result<u64>> {
        std::env::var("BUTLER_E2E_DISK_AVAILABLE_BYTES")
            .ok()
            .map(|value| value.parse().map_err(io::Error::other))
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn update_checkpoint(step: &str) {
        if std::env::var("BUTLER_APP_UPDATE_CHECKPOINT").as_deref() == Ok(step) {
            use std::io::Write;
            println!("app-update-checkpoint:{step}");
            let _ = std::io::stdout().flush();
            loop {
                std::thread::park();
            }
        }
    }
}
