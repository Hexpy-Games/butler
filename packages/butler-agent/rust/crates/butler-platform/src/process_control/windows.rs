//! Windows has no process-group containment yet; Job Objects replace this in
//! the Windows stage. Callers stop only their direct child meanwhile.

use std::process::{Command, ExitStatus, Stdio};

use super::{ExitSignal, GroupSignal, Liveness, SignalError};

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

pub(super) fn isolate_group(_command: &mut Command) -> Option<&mut Command> {
    None
}

pub(super) fn signal_group(_pid: u32, _signal: GroupSignal) -> Result<(), SignalError> {
    Err(SignalError::Unsupported)
}

pub(super) fn terminating_signal(_status: ExitStatus) -> Option<ExitSignal> {
    None
}

/// Asks `tasklist` for the process until the Windows stage reads the process
/// table directly. Pid 0 (the idle process) is no process of ours, and
/// process ids stay far below `i32::MAX`, past which `tasklist` rejects the
/// query.
pub(super) fn liveness(pid: u32) -> Liveness {
    if pid == 0 || i32::try_from(pid).is_err() {
        return Liveness::Gone;
    }
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let output = match output {
        Ok(output) if output.status.success() => output,
        _ => return Liveness::Unknown,
    };
    let pid = pid.to_string();
    let listed = String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        line.split(',')
            .nth(1)
            .is_some_and(|field| field.trim_matches('"') == pid)
    });
    if listed {
        Liveness::Running
    } else {
        Liveness::Gone
    }
}
