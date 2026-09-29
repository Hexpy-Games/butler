//! The Windows process table, read through `sysinfo`.
//!
//! A [`ProcessView`] opens a handle to the process it reads and keeps it open
//! while the view lives. Windows never gives a process id to another process
//! while a handle to the old one is open, so everything done through a live
//! view (comparing the start time, then ending the process) addresses the
//! process that was read, even if it exits in between.

use std::path::PathBuf;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// One process of the table, with an open handle to it (see the module).
pub(crate) struct ProcessView {
    system: System,
    pid: Pid,
}

impl ProcessView {
    /// Reads process `pid`: its start time and executable. `None` when no
    /// process has the id.
    pub(crate) fn read(pid: u32) -> Option<Self> {
        let pid = Pid::from_u32(pid);
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
        );
        system.process(pid)?;
        Some(Self { system, pid })
    }

    /// When the process started, in whole seconds since the Unix epoch; 0
    /// when this user may not open the process.
    pub(crate) fn started_at_seconds(&self) -> u64 {
        self.system
            .process(self.pid)
            .map_or(0, sysinfo::Process::start_time)
    }

    /// The process's executable, without the `\\?\` prefix where the path
    /// does not need it; `None` when this user may not read it.
    pub(crate) fn executable(&self) -> Option<PathBuf> {
        let executable = self.system.process(self.pid)?.exe()?;
        Some(dunce::simplified(executable).to_path_buf())
    }

    /// Ends the process at once (`TerminateProcess` through the handle this
    /// view holds, not a tool found on `PATH`), while the view keeps its id
    /// from naming another process. Whether the process was ended.
    pub(crate) fn kill(&self) -> bool {
        self.system
            .process(self.pid)
            .is_some_and(sysinfo::Process::kill)
    }
}

/// The host name (the DNS host name of this computer).
pub(crate) fn host_name() -> Option<String> {
    System::host_name()
}

/// The Windows build number, such as `26200`.
pub(crate) fn build_number() -> Option<String> {
    System::kernel_version()
}
