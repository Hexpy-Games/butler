fn main() -> std::process::ExitCode {
    #[cfg(windows)]
    {
        eprintln!("start butler_cef_host.exe (bootstrap), not this binary");
        std::process::ExitCode::FAILURE
    }
    #[cfg(not(windows))]
    {
        std::process::ExitCode::from(
            u8::try_from(butler_cef_host::run(std::ptr::null_mut())).unwrap_or(1),
        )
    }
}
