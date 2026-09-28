//! Process trees, group signals, exit signals and liveness.
//!
//! Unix starts a contained command as the leader of its own process group and
//! signals the whole group, so descendants a command leaves behind stop with
//! it. Windows has no process-group containment yet (Job Objects replace it):
//! [`CONTAINS_PROCESS_TREES`] is `false`, [`isolate_group`] returns `None`,
//! group signals report [`SignalError::Unsupported`] and callers stop only
//! their direct child.

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

/// The signal that terminated a process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitSignal {
    /// SIGINT.
    Interrupt,
    /// SIGKILL.
    Kill,
    /// SIGTERM.
    Terminate,
    /// Any other signal, by its number on this host.
    Other(i32),
}

impl ExitSignal {
    /// The signal's name: `SIGINT`, `SIGKILL`, `SIGTERM`, or `SIG<number>`.
    pub fn name(self) -> String {
        match self {
            Self::Interrupt => "SIGINT".to_owned(),
            Self::Kill => "SIGKILL".to_owned(),
            Self::Terminate => "SIGTERM".to_owned(),
            Self::Other(number) => format!("SIG{number}"),
        }
    }
}

/// Why a process group could not be signalled.
#[derive(Debug, thiserror::Error)]
pub enum SignalError {
    /// The id names no single process group: 0 (the caller's own group) or
    /// an id outside the host's range.
    #[error("process id {0} names no single process group")]
    InvalidPid(u32),
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

/// Whether a process id names a running process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Liveness {
    /// The process exists (and, on Unix, this user may signal it).
    Running,
    /// The process exists but belongs to another user.
    OtherOwner,
    /// No process has this id (ids that name no single process included).
    Gone,
    /// The host could not tell.
    Unknown,
}

/// Makes `command` start as the leader of a new process group, so
/// [`signal_group`] reaches everything it starts. `None` when this host
/// cannot contain process trees and `command` is unchanged.
pub fn isolate_group(command: &mut Command) -> Option<&mut Command> {
    sys::isolate_group(command)
}

/// Signals the process group led by `pid`. A group that no longer exists, or
/// whose remaining members are all zombies, is already stopped. Pid 0 (the
/// caller's own group) and ids outside the host's range are refused.
pub fn signal_group(pid: u32, signal: GroupSignal) -> Result<(), SignalError> {
    sys::signal_group(pid, signal)
}

/// The signal that terminated the process, if a signal did.
pub fn terminating_signal(status: ExitStatus) -> Option<ExitSignal> {
    sys::terminating_signal(status)
}

/// Whether a process with id `pid` is running.
pub fn liveness(pid: u32) -> Liveness {
    sys::liveness(pid)
}
