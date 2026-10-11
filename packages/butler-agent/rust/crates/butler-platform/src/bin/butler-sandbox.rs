//! Single-threaded command boundary: exec retains the PID and process group.
#![forbid(unsafe_code)]

#[cfg(target_os = "linux")]
fn main() {
    if let Err(error) = butler_platform::command_sandbox::trampoline() {
        eprintln!("command_observation_isolation_unavailable: {error}");
        std::process::exit(125);
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {}
