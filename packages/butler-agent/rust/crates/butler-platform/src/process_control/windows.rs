//! Job Objects contain command trees; console control events are this
//! process's stop requests, and a thread watches the stdin lease.
//!
//! A contained command runs in a Job Object of its own that ends every
//! process in it when its last handle closes. [`contain`] assigns the
//! command right after it starts (a child that starts processes before that
//! moment leaves them outside the job), and [`signal_group`] closes the job:
//! Windows has no graceful stop for console processes, so a terminate and a
//! kill both end the tree at once. Butler holds the only handle, so its own
//! exit ends every command tree it still contains too.

use std::collections::HashMap;
use std::io::{self, Read};
use std::os::windows::io::{AsRawHandle, RawHandle};
use std::os::windows::process::CommandExt;
use std::process::{Command, ExitStatus};
use std::sync::{LazyLock, Mutex, PoisonError};

use tokio::signal::windows::{
    CtrlBreak, CtrlC, CtrlClose, CtrlShutdown, ctrl_break, ctrl_c, ctrl_close, ctrl_shutdown,
};
use tokio::sync::watch;
use win32job::{ExtendedLimitInfo, Job};

use super::{ExitSignal, GroupSignal, Liveness, ShutdownRequest, SignalError};
use crate::process_table::ProcessView;

pub(super) const CONTAINS_PROCESS_TREES: bool = true;

pub(super) const SIGNALS: bool = false;

/// `DETACHED_PROCESS`: the child has no console.
const DETACHED_PROCESS: u32 = 0x0000_0008;
/// `CREATE_NEW_PROCESS_GROUP`: console control events of the caller's group
/// do not reach the child.
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
/// `CREATE_NO_WINDOW`: a console program runs without opening a window,
/// even when this process (a detached service) has no console to share.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The Job Object of each contained command, by the command's process id.
static JOBS: LazyLock<Mutex<HashMap<u32, Job>>> = LazyLock::new(Mutex::default);

pub(super) const SYSTEM_ENVIRONMENT: &[&str] = &[
    "ComSpec",
    "PATH",
    "PATHEXT",
    "SystemDrive",
    "SystemRoot",
    "windir",
];

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

pub(super) fn isolate_group(command: &mut Command) -> Option<&mut Command> {
    Some(command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW))
}

pub(super) fn contain_tokio(child: &tokio::process::Child) -> io::Result<()> {
    match (child.id(), child.raw_handle()) {
        (Some(pid), Some(handle)) => contain(pid, handle),
        _ => Err(io::Error::new(
            io::ErrorKind::NotFound,
            "the command exited before it was contained",
        )),
    }
}

pub(super) fn contain_std(child: &std::process::Child) -> io::Result<()> {
    contain(child.id(), child.as_raw_handle())
}

/// Creates the command's job (ending its processes when closed) and assigns
/// the process to it.
fn contain(pid: u32, process: RawHandle) -> io::Result<()> {
    let mut limits = ExtendedLimitInfo::new();
    limits.limit_kill_on_job_close();
    let job = Job::create_with_limit_info(&limits).map_err(io::Error::other)?;
    // The handle is only passed to AssignProcessToJobObject, never closed.
    job.assign_process(process as isize)
        .map_err(io::Error::other)?;
    let mut jobs = JOBS.lock().unwrap_or_else(PoisonError::into_inner);
    // Jobs whose processes have all exited hold nothing to stop any more.
    jobs.retain(|_, job| {
        job.query_process_id_list()
            .is_ok_and(|processes| !processes.is_empty())
    });
    jobs.insert(pid, job);
    Ok(())
}

/// Closes the command's job, which ends every process in it. A command that
/// was never contained, or whose job is closed already, is stopped.
pub(super) fn signal_group(pid: u32, _signal: GroupSignal) -> Result<(), SignalError> {
    if pid == 0 || i32::try_from(pid).is_err() {
        return Err(SignalError::InvalidPid(pid));
    }
    let job = JOBS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&pid);
    drop(job);
    Ok(())
}

pub(super) fn terminating_signal(_status: ExitStatus) -> Option<ExitSignal> {
    None
}

/// Reads the process table. Pid 0 (the idle process) is no process of ours,
/// and process ids stay far below `i32::MAX`.
pub(super) fn liveness(pid: u32) -> Liveness {
    if pid == 0 || i32::try_from(pid).is_err() {
        return Liveness::Gone;
    }
    if ProcessView::read(pid).is_some() {
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

pub(super) fn hide_console(command: &mut Command) -> &mut Command {
    command.creation_flags(CREATE_NO_WINDOW)
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

/// Windows has no hangup or broken-pipe signal; a session ends like any stop.
pub(super) fn session_shutdown_requests() -> io::Result<ShutdownRequests> {
    shutdown_requests()
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
