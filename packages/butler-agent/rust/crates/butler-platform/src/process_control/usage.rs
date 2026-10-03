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
    /// Bytes fetched from storage, excluding OS cache hits. Windows supplies
    /// a conservative native I/O upper bound, including cached/network reads.
    pub read_bytes: u64,
    /// Bytes submitted to writes, including writes buffered by the OS.
    pub write_chars: Option<u64>,
    /// Bytes written to storage. Windows supplies a conservative native I/O
    /// upper bound, including buffered/network writes.
    pub write_bytes: u64,
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
            write_chars: Some(counter(&io, "wchar")?),
            write_bytes: counter(&io, "write_bytes")?,
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
            write_chars: None,
            write_bytes: usage.ri_diskio_byteswritten,
        }))
    }
    #[cfg(target_os = "windows")]
    {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let pid = Pid::from_u32(pid);
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing()
                .with_memory()
                .with_disk_usage(),
        );
        let process = system
            .process(pid)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "process unavailable"))?;
        let disk = process.disk_usage();
        // sysinfo reads GetProcessIoCounters on Windows. Unlike directory
        // timestamps, these count writes even while WAL handles remain open.
        Ok(Some(ProcessUsage {
            resident_bytes: process.memory(),
            proportional_bytes: None,
            footprint_bytes: None,
            read_chars: Some(disk.total_read_bytes),
            read_bytes: disk.total_read_bytes,
            write_chars: Some(disk.total_written_bytes),
            write_bytes: disk.total_written_bytes,
        }))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
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

/// Private embedding children of this parent; unsupported platforms return None.
pub fn embedding_children(parent: u32) -> io::Result<Option<Vec<u32>>> {
    #[cfg(target_os = "linux")]
    {
        // Linux attributes children to the spawning thread, which may be a Tokio worker.
        let mut children = std::collections::BTreeSet::new();
        for task in std::fs::read_dir(format!("/proc/{parent}/task"))? {
            let task = task?;
            if let Ok(pids) = std::fs::read_to_string(task.path().join("children")) {
                children.extend(
                    pids.split_whitespace()
                        .filter_map(|pid| pid.parse::<u32>().ok()),
                );
            }
        }
        let mut workers = Vec::new();
        for pid in children {
            if std::fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|args| {
                args.split(|byte| *byte == 0)
                    .any(|arg| arg == b"--private-embedding-worker")
            }) {
                workers.push(pid);
            }
        }
        Ok(Some(workers))
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
        );
        let workers = system
            .processes()
            .iter()
            .filter_map(|(pid, process)| {
                (process.parent() == Some(Pid::from_u32(parent))
                    && process
                        .cmd()
                        .iter()
                        .any(|arg| arg == "--private-embedding-worker"))
                .then_some(pid.as_u32())
            })
            .collect();
        Ok(Some(workers))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = parent;
        Ok(None)
    }
}
