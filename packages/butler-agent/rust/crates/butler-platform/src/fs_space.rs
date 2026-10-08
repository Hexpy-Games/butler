//! Available bytes on the volume containing a startup correction file.
use std::{io, path::Path};

/// Free bytes on the most specific mounted volume containing `path`.
pub fn available_bytes(path: &Path) -> io::Result<u64> {
    #[cfg(debug_assertions)]
    if matches!(
        std::env::var("BUTLER_E2E_TIER").as_deref(),
        Ok("stub" | "perf")
    ) && let Ok(value) = std::env::var("BUTLER_E2E_DISK_AVAILABLE_BYTES")
    {
        return value.parse().map_err(io::Error::other);
    }
    let path = super::secure_fs::canonicalize(path)?;
    sysinfo::Disks::new_with_refreshed_list()
        .iter()
        .filter(|disk| path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(sysinfo::Disk::available_space)
        .ok_or_else(|| io::Error::other("storage volume not found"))
}
