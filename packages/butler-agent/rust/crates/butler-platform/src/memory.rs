//! Physical memory facts for sizing resource budgets.

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
