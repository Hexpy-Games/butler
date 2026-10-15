//! Single-threaded command boundary: exec retains the PID and process group.
#![forbid(unsafe_code)]

#[cfg(target_os = "linux")]
fn main() {
    if let Err(error) = butler_platform::command_sandbox::trampoline() {
        eprintln!("command_observation_isolation_unavailable: {error}");
        std::process::exit(125);
    }
}

#[cfg(windows)]
fn main() {
    match butler_platform::command_sandbox::windows_sandbox_helper() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("command_observation_isolation_unavailable: {error}");
            std::process::exit(125);
        }
    }
}
#[cfg(not(any(target_os = "linux", windows)))]
fn main() {}
