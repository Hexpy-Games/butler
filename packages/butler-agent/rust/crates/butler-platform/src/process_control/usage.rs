//! Process resource samples for isolated performance scenarios.

use std::io;

/// Resident memory and cumulative I/O counters for one process.
#[derive(Debug, Clone, Copy)]
pub struct ProcessUsage {
    /// Resident bytes, including shared mappings.
    pub resident_bytes: u64,
    /// Proportional resident bytes (shared mappings divided among users).
    pub proportional_bytes: Option<u64>,
    /// macOS physical footprint, excluding clean file-backed mappings.
    pub footprint_bytes: Option<u64>,
    /// Bytes returned by reads, including reads satisfied by the OS cache.
    pub read_chars: Option<u64>,
    /// Bytes fetched from storage, excluding OS cache hits.
    pub read_bytes: u64,
}

/// Samples native process counters; unavailable metrics remain `None`.
pub fn sample(pid: u32) -> io::Result<Option<ProcessUsage>> {
    #[cfg(target_os = "linux")]
    {
        let memory = std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup"))?;
        let io = std::fs::read_to_string(format!("/proc/{pid}/io"))?;
        Ok(Some(ProcessUsage {
            resident_bytes: counter(&memory, "Rss")? * 1024,
            proportional_bytes: Some(counter(&memory, "Pss")? * 1024),
            footprint_bytes: None,
            read_chars: Some(counter(&io, "rchar")?),
            read_bytes: counter(&io, "read_bytes")?,
        }))
    }
    #[cfg(target_os = "macos")]
    {
        use libproc::pid_rusage::{RUsageInfoV2, pidrusage};
        let pid = i32::try_from(pid)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        let usage = pidrusage::<RUsageInfoV2>(pid).map_err(io::Error::other)?;
        Ok(Some(ProcessUsage {
            resident_bytes: usage.ri_resident_size,
            proportional_bytes: None,
            footprint_bytes: Some(usage.ri_phys_footprint),
            read_chars: None,
            read_bytes: usage.ri_diskio_bytesread,
        }))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        Ok(None)
    }
}

#[cfg(target_os = "linux")]
fn counter(text: &str, name: &str) -> io::Result<u64> {
    text.lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| *key == name)
        .and_then(|(_, value)| value.split_whitespace().next())
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing process counter"))
}
