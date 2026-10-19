//! Physical memory facts and allocator startup policy.

use std::sync::OnceLock;

/// The machine's installed physical memory in bytes, or 0 where the operating
/// system does not report it.
pub fn total_bytes() -> u64 {
    static TOTAL: OnceLock<u64> = OnceLock::new();
    *TOTAL.get_or_init(|| {
        let mut system = sysinfo::System::new();
        system.refresh_memory_specifics(sysinfo::MemoryRefreshKind::nothing().with_ram());
        system.total_memory()
    })
}

/// Bound GNU libc's retained free heap after temporary startup allocations.
///
/// A fixed trim threshold also stops glibc from increasing its mmap threshold
/// after large transient allocations. Keep the native arena count and retain
/// 1 MiB of free heap before trimming, to amortize allocation system calls.
/// glibc reads this environment before main, so exec once before starting any
/// workers. Exec preserves the PID, arguments and descriptors; caller settings
/// take precedence.
pub fn prepare_allocator() -> std::io::Result<()> {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        use std::os::unix::process::CommandExt;

        if std::env::var_os("MALLOC_TRIM_THRESHOLD_").is_none() {
            return Err(std::process::Command::new(std::env::current_exe()?)
                .args(std::env::args_os().skip(1))
                .env("MALLOC_TRIM_THRESHOLD_", "1048576")
                .exec());
        }
    }
    Ok(())
}
