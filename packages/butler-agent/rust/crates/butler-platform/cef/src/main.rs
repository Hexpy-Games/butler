fn main() -> std::process::ExitCode {
    #[cfg(windows)]
    {
        eprintln!("start butler_cef_host.exe (bootstrap), not this binary");
        std::process::ExitCode::FAILURE
    }
    #[cfg(not(windows))]
    {
        #[cfg(target_os = "linux")]
        shorten_temp_path();
        std::process::ExitCode::from(
            u8::try_from(butler_cef_host::run(std::ptr::null_mut())).unwrap_or(1),
        )
    }
}

/// Keep Chrome's singleton socket below the Unix socket path limit (104–108 bytes).
/// Chrome removes its own temporary entries when it exits.
#[cfg(target_os = "linux")]
fn shorten_temp_path() {
    if std::env::var_os("TMPDIR").is_none_or(|path| path.len() > 60) {
        // SAFETY: `main` has not started any thread yet (CEF starts its threads in `run`), so no other
        // thread can read the environment while it changes.
        #[allow(
            unsafe_code,
            reason = "std::env::set_var before any thread exists; see SAFETY"
        )]
        unsafe {
            std::env::set_var("TMPDIR", "/tmp");
        }
    }
}
