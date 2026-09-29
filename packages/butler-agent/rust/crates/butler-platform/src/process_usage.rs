//! Cumulative I/O and CPU counters for one process.

use std::io;
use std::time::Duration;

/// Counters since the process started. Disk bytes are physical I/O, where the
/// host provides them; CPU time sums user and kernel time across threads.
#[derive(Clone, Copy, Debug)]
pub struct ProcessUsage {
    /// Bytes read from storage.
    pub read_bytes: u64,
    /// Bytes written to storage.
    pub written_bytes: u64,
    /// Total CPU time across all threads.
    pub cpu_time: Duration,
}

/// Read the cumulative counters for the current process.
pub fn current() -> io::Result<ProcessUsage> {
    for_pid(std::process::id())
}

/// Read the cumulative counters for `pid`. A missing process returns an I/O
/// error. Windows reports `Unsupported` until a safe process-handle API is
/// available in our dependencies.
pub fn for_pid(pid: u32) -> io::Result<ProcessUsage> {
    #[cfg(target_os = "macos")]
    {
        use libproc::libproc::pid_rusage::{RUsageInfoV2, pidrusage};
        let pid = i32::try_from(pid)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        let usage = pidrusage::<RUsageInfoV2>(pid).map_err(io::Error::other)?;
        Ok(ProcessUsage {
            read_bytes: usage.ri_diskio_bytesread,
            written_bytes: usage.ri_diskio_byteswritten,
            cpu_time: Duration::from_nanos(usage.ri_user_time.saturating_add(usage.ri_system_time)),
        })
    }
    #[cfg(target_os = "linux")]
    {
        linux::for_pid(pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "process I/O counters unavailable",
        ))
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::ProcessUsage;
    use std::io;
    use std::time::Duration;

    pub(super) fn for_pid(pid: u32) -> io::Result<ProcessUsage> {
        let io_text = std::fs::read_to_string(format!("/proc/{pid}/io"))?;
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
        let fields = stat.rsplit_once(") ").ok_or_else(invalid_data)?.1;
        // The suffix starts at field 3 (state); fields 14 and 15 are CPU ticks.
        let mut fields = fields.split_whitespace();
        let user = fields
            .nth(11)
            .ok_or_else(invalid_data)?
            .parse::<u64>()
            .map_err(|_| invalid_data())?;
        let system = fields
            .next()
            .ok_or_else(invalid_data)?
            .parse::<u64>()
            .map_err(|_| invalid_data())?;
        let ticks_per_second = rustix::param::clock_ticks_per_second();
        if ticks_per_second == 0 {
            return Err(invalid_data());
        }
        let ticks = user.saturating_add(system);
        Ok(ProcessUsage {
            read_bytes: counter(&io_text, "read_bytes:")?,
            written_bytes: counter(&io_text, "write_bytes:")?,
            cpu_time: Duration::from_secs(ticks / ticks_per_second)
                + Duration::from_nanos(
                    (ticks % ticks_per_second).saturating_mul(1_000_000_000) / ticks_per_second,
                ),
        })
    }

    fn counter(text: &str, key: &str) -> io::Result<u64> {
        text.lines()
            .find_map(|line| line.strip_prefix(key))
            .ok_or_else(invalid_data)?
            .trim()
            .parse()
            .map_err(|_| invalid_data())
    }

    fn invalid_data() -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, "invalid proc process counters")
    }
}
