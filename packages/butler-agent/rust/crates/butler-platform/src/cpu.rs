//! CPU topology facts for sizing thread pools.

use std::sync::OnceLock;

/// The number of performance cores: the cores worth running a compute thread
/// on. Efficiency cores are left out where the operating system reports them
/// separately (Apple silicon), so a pool sized from this does not park work on
/// slow cores. Falls back to the available parallelism, and never returns 0.
pub fn performance_cores() -> usize {
    static CORES: OnceLock<usize> = OnceLock::new();
    *CORES.get_or_init(|| detect().unwrap_or_else(available).max(1))
}

fn available() -> usize {
    std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get)
}

#[cfg(target_os = "macos")]
fn detect() -> Option<usize> {
    // `hw.perflevel0` is the highest-performance cluster on Apple silicon.
    let output = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.perflevel0.physicalcpu"])
        .output()
        .ok()?;
    String::from_utf8(output.stdout)
        .ok()?
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|count| *count > 0)
}

#[cfg(not(target_os = "macos"))]
fn detect() -> Option<usize> {
    None
}
