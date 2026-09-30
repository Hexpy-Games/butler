//! Process resource samples for isolated performance scenarios.

use std::io;

/// Resident memory and cumulative I/O counters for one process.
#[derive(Debug, Clone, Copy)]
pub struct ProcessUsage {
    /// Resident bytes, including shared mappings.
    pub resident_bytes: u64,
    /// Proportional resident bytes (shared mappings divided among users).
    pub proportional_bytes: u64,
    /// Bytes returned by reads, including reads satisfied by the OS cache.
    pub read_chars: u64,
    /// Bytes fetched from storage, excluding OS cache hits.
    pub read_bytes: u64,
}

/// Samples Linux procfs; returns `None` where these counters are unavailable.
pub fn sample(pid: u32) -> io::Result<Option<ProcessUsage>> {
    #[cfg(target_os = "linux")]
    {
        let memory = std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup"))?;
        let io = std::fs::read_to_string(format!("/proc/{pid}/io"))?;
        Ok(Some(ProcessUsage {
            resident_bytes: counter(&memory, "Rss")? * 1024,
            proportional_bytes: counter(&memory, "Pss")? * 1024,
            read_chars: counter(&io, "rchar")?,
            read_bytes: counter(&io, "read_bytes")?,
        }))
    }
    #[cfg(not(target_os = "linux"))]
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
