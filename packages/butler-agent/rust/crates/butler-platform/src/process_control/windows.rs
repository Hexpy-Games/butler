//! Windows has no process-group containment yet; Job Objects replace this in
//! the Windows stage. Callers stop only their direct child meanwhile.

use std::process::{Command, ExitStatus};

use super::{GroupSignal, Liveness, SignalError};

pub(super) const CONTAINS_PROCESS_TREES: bool = false;

pub(super) const BASELINE_ENVIRONMENT: &[&str] = &[
    "APPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "PATH",
    "PROCESSOR_ARCHITECTURE",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "USERNAME",
    "USERPROFILE",
    "PROGRAMFILES",
];

pub(super) fn isolate_group(_command: &mut Command) {}

pub(super) fn signal_group(_pid: u32, _signal: GroupSignal) -> Result<(), SignalError> {
    Err(SignalError::Unsupported)
}

pub(super) fn terminating_signal(_status: ExitStatus) -> Option<i32> {
    None
}

pub(super) fn liveness(_pid: u32) -> Liveness {
    Liveness::Unknown
}
