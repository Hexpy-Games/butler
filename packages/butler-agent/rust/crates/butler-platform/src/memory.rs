//! Allocator startup policy and physical memory facts for resource budgets.

use std::sync::OnceLock;

/// Apply allocator defaults before starting any runtime threads.
///
/// glibc otherwise raises its trim threshold after bulk allocations, retaining
/// freed maintenance memory. Keep its initial 128 KiB trim threshold and bound
/// fragmented free space to two arenas. Existing caller settings win.
/// The loader reads this setting before main, so restart this process once;
/// exec preserves its PID, arguments, working directory and inherited handles.
pub fn prepare_allocator() -> std::io::Result<()> {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        use std::os::unix::process::CommandExt;
        let defaults = [
            ("MALLOC_TRIM_THRESHOLD_", "131072"),
            ("MALLOC_ARENA_MAX", "2"),
        ];
        let missing: Vec<_> = defaults
            .into_iter()
            .filter(|(name, _)| std::env::var_os(name).is_none())
            .collect();
        if missing.is_empty() {
            return Ok(());
        }
        let mut command = std::process::Command::new(std::env::current_exe()?);
        let mut arguments = std::env::args_os();
        if let Some(name) = arguments.next() {
            command.arg0(name);
        }
        command.args(arguments).envs(missing);
        Err(command.exec())
    }
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    {
        Ok(())
    }
}

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
