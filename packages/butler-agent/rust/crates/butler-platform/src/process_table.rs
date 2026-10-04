//! Windows process handles, with `sysinfo` retained for executable paths and host facts.
//!
//! A [`ProcessView`] opens a handle to the process it reads and keeps it open
//! while the view lives. Windows never gives a process id to another process
//! while a handle to the old one is open, so everything done through a live
//! view (comparing the start time, then ending the process) addresses the
//! process that was read, even if it exits in between.

use std::io;
use std::path::PathBuf;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use winsafe::{HPROCESS, co, guard::CloseHandleGuard};

/// One process, held open so its PID cannot be reused while identity is checked.
pub(crate) struct ProcessView {
    handle: CloseHandleGuard<HPROCESS>,
    pid: Pid,
}

impl ProcessView {
    /// Opens the process directly. A process-table snapshot may still contain
    /// an exiting PID for which a subsequent handle open no longer succeeds.
    pub(crate) fn read(pid: u32) -> io::Result<Option<Self>> {
        if pid == 0 {
            return Ok(None);
        }
        let access = co::PROCESS::QUERY_LIMITED_INFORMATION | co::PROCESS::SYNCHRONIZE;
        let handle = match HPROCESS::OpenProcess(access, false, pid) {
            Ok(handle) => handle,
            Err(co::ERROR::INVALID_PARAMETER) => return Ok(None),
            Err(error) => return Err(unavailable(error)),
        };
        let view = Self {
            handle,
            pid: Pid::from_u32(pid),
        };
        Ok((!view.exited()?).then_some(view))
    }

    /// Whether the held process object is signaled, independent of table entries.
    fn exited(&self) -> io::Result<bool> {
        self.handle
            .WaitForSingleObject(Some(0))
            .map(|state| state == co::WAIT::OBJECT_0)
            .map_err(unavailable)
    }

    /// Its creation time, preserving the instance record's whole-second format.
    pub(crate) fn started_at_seconds(&self) -> io::Result<u64> {
        let (creation, _, _, _) = self.handle.GetProcessTimes().map_err(unavailable)?;
        (u64::from(creation) / 10_000_000)
            .checked_sub(11_644_473_600)
            .filter(|seconds| *seconds > 0)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Process creation time is unavailable",
                )
            })
    }

    /// The executable path, retaining sysinfo's support for long Windows paths.
    /// The native handle pins the PID throughout the table lookup.
    pub(crate) fn executable(&self) -> io::Result<Option<PathBuf>> {
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[self.pid]),
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
        );
        if let Some(path) = system.process(self.pid).and_then(sysinfo::Process::exe) {
            return Ok(Some(dunce::simplified(path).to_path_buf()));
        }
        if self.exited()? {
            Ok(None)
        } else {
            Err(io::Error::other("Process executable is unavailable"))
        }
    }

    /// Ends the held process. The query handle prevents PID reuse while a
    /// terminate handle is opened; permission failures remain errors.
    pub(crate) fn kill(&self) -> io::Result<bool> {
        if self.exited()? {
            return Ok(false);
        }
        let handle = HPROCESS::OpenProcess(co::PROCESS::TERMINATE, false, self.pid.as_u32())
            .map_err(unavailable)?;
        match handle.TerminateProcess(1) {
            Ok(()) => Ok(true),
            Err(_) if self.exited()? => Ok(false),
            Err(error) => Err(unavailable(error)),
        }
    }
}

fn unavailable(error: co::ERROR) -> io::Error {
    io::Error::from_raw_os_error(i32::from_ne_bytes(error.raw().to_ne_bytes()))
}

/// The host name (the DNS host name of this computer).
pub(crate) fn host_name() -> Option<String> {
    System::host_name()
}

/// The Windows build number, such as `26200`.
pub(crate) fn build_number() -> Option<String> {
    System::kernel_version()
}
