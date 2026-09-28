//! Windows has no process-group containment yet; Job Objects replace this in
//! the Windows stage. Callers stop only their direct child meanwhile.
//! Console control events are this process's stop requests, and a thread
//! watches the stdin lease.

use std::io::{self, Read};
use std::os::windows::process::CommandExt;
use std::process::{Command, ExitStatus, Stdio};

use tokio::signal::windows::{
    CtrlBreak, CtrlC, CtrlClose, CtrlShutdown, ctrl_break, ctrl_c, ctrl_close, ctrl_shutdown,
};
use tokio::sync::watch;

use super::{ExitSignal, GroupSignal, Liveness, ShutdownRequest, SignalError};

pub(super) const CONTAINS_PROCESS_TREES: bool = false;

pub(super) const SIGNALS: bool = false;

/// `DETACHED_PROCESS`: the child has no console.
const DETACHED_PROCESS: u32 = 0x0000_0008;
/// `CREATE_NEW_PROCESS_GROUP`: console control events of the caller's group
/// do not reach the child.
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

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

pub(super) fn target_liveness(target: i32) -> Liveness {
    match u32::try_from(target) {
        Ok(pid) if pid > 0 => liveness(pid),
        _ => Liveness::Unknown,
    }
}

pub(super) fn detach(command: &mut Command) -> &mut Command {
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
}

/// The console control events that ask a console process to stop. A
/// detached process has no console and receives none of them.
#[derive(Debug)]
pub(super) struct ShutdownRequests {
    interrupt: CtrlC,
    interrupt_break: CtrlBreak,
    close: CtrlClose,
    shutdown: CtrlShutdown,
}

pub(super) fn shutdown_requests() -> io::Result<ShutdownRequests> {
    Ok(ShutdownRequests {
        interrupt: ctrl_c()?,
        interrupt_break: ctrl_break()?,
        close: ctrl_close()?,
        shutdown: ctrl_shutdown()?,
    })
}

impl ShutdownRequests {
    pub(super) async fn recv(&mut self) -> ShutdownRequest {
        tokio::select! {
            _ = self.interrupt.recv() => ShutdownRequest::Interrupt,
            _ = self.interrupt_break.recv() => ShutdownRequest::Terminate,
            _ = self.close.recv() => ShutdownRequest::Terminate,
            _ = self.shutdown.recv() => ShutdownRequest::Terminate,
        }
    }
}

/// How reading stdin ended: `Ok` at its end, else the read error's kind and
/// text (`io::Error` cannot be shared between waiters).
type LeaseEnd = Result<(), (io::ErrorKind, String)>;

/// Reads stdin on a thread of its own until it ends: a pipe whose writer
/// closed reads as its end. The thread ends with the process otherwise.
#[derive(Debug)]
pub(super) struct StdinLease {
    ended: watch::Receiver<Option<LeaseEnd>>,
}

impl StdinLease {
    pub(super) fn capture() -> io::Result<Self> {
        let (sender, ended) = watch::channel(None);
        std::thread::Builder::new()
            .name("butler-stdin-lease".into())
            .spawn(move || {
                sender.send_replace(Some(read_to_end_of_stdin()));
            })?;
        Ok(Self { ended })
    }

    pub(super) async fn closed(&self) -> io::Result<()> {
        let mut ended = self.ended.clone();
        let end = ended.wait_for(Option::is_some).await.map(|end| end.clone());
        match end {
            Ok(Some(Ok(()))) => Ok(()),
            Ok(Some(Err((kind, message)))) => Err(io::Error::new(kind, message)),
            Ok(None) | Err(_) => Err(io::Error::other("the stdin lease reader stopped")),
        }
    }
}

fn read_to_end_of_stdin() -> LeaseEnd {
    let mut stdin = io::stdin().lock();
    let mut buffer = [0_u8; 64];
    loop {
        match stdin.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err((error.kind(), error.to_string())),
        }
    }
}
