//! Physical memory facts and release of unused allocator pages.

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

/// Return free heap pages after a bulk operation becomes idle.
///
/// Call on a blocking worker after dropping temporary allocations. This may
/// lock allocator arenas, so it belongs at a change-driven maintenance boundary,
/// not on request paths or an idle polling timer. Other allocators/platforms
/// retain their native release policy.
pub fn release_unused_heap() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    pprof_alloc::stats::malloc::malloc_trim();
}
