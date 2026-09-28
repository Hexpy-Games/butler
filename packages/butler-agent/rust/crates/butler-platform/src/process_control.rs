//! Process trees, group signals, exit signals and liveness.
//!
//! Unix starts a contained command as the leader of its own process group and
//! signals the whole group, so descendants a command leaves behind stop with
//! it. Windows has no process-group containment yet (Job Objects replace it):
//! [`CONTAINS_PROCESS_TREES`] is `false`, group signals report
//! [`SignalError::Unsupported`] and callers stop only their direct child.

use std::num::TryFromIntError;
use std::process::{Command, ExitStatus};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// Whether a command started with [`isolate_group`] can be stopped together
/// with every descendant through [`signal_group`]. Without it, callers stop
/// only the direct child they spawned.
pub const CONTAINS_PROCESS_TREES: bool = sys::CONTAINS_PROCESS_TREES;

/// The variables a sanitized child environment keeps from its parent: what a
/// program needs to find the user, the shell and executables on this host
/// (the MCP SDK's default inherited environment).
pub const BASELINE_ENVIRONMENT: &[&str] = sys::BASELINE_ENVIRONMENT;

/// The signal sent to a command's process group.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GroupSignal {
    /// SIGTERM: ask the group to exit within the caller's grace period.
    Terminate,
    /// SIGKILL: stop the group unconditionally.
    Kill,
}

/// Why a process group could not be signalled.
#[derive(Debug, thiserror::Error)]
pub enum SignalError {
    /// The process id cannot name a process group on this host.
    #[error("process id is outside the supported signal range")]
    OutOfRange(#[source] TryFromIntError),
    /// The host refused to deliver `signal`; `detail` is the host's reason.
    #[error("{signal}: {detail}")]
    Delivery {
        /// The signal's name, such as `SIGTERM`.
        signal: &'static str,
        /// The host's description of the failure.
        detail: String,
    },
    /// This host has no process-group signals (see [`CONTAINS_PROCESS_TREES`]).
    #[error("process-group signals are unsupported on this host")]
    Unsupported,
}

/// What signal 0 reports about a process id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Liveness {
    /// The process exists and this user may signal it.
    Running,
    /// The process exists but belongs to another user.
    OtherOwner,
    /// No process has this id (ids that name no single process included).
    Gone,
    /// This host cannot tell.
    Unknown,
}

/// Makes `command` start as the leader of a new process group, so
/// [`signal_group`] reaches everything it starts.
pub fn isolate_group(command: &mut Command) {
    sys::isolate_group(command);
}

/// Signals the process group led by `pid`. A group that no longer exists, or
/// whose remaining members are all zombies, is already stopped.
pub fn signal_group(pid: u32, signal: GroupSignal) -> Result<(), SignalError> {
    sys::signal_group(pid, signal)
}

/// The number of the signal that terminated the process, if a signal did.
pub fn terminating_signal(status: ExitStatus) -> Option<i32> {
    sys::terminating_signal(status)
}

/// Whether a process with id `pid` exists, as signal 0 reports it.
pub fn liveness(pid: u32) -> Liveness {
    sys::liveness(pid)
}
