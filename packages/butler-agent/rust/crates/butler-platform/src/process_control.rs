//! Process trees, group signals, exit signals, liveness, detached processes
//! and the stop requests this process receives.
//!
//! Unix starts a contained command as the leader of its own process group and
//! signals the whole group, so descendants a command leaves behind stop with
//! it. Windows puts the command in a Job Object of its own right after it
//! starts ([`contain`]) and closes the job to stop the tree: it has no
//! graceful stop for console processes, so [`GroupSignal::Terminate`] ends
//! the tree at once, like [`GroupSignal::Kill`].
//!
//! A service learns that it should stop from [`shutdown_requests`] (SIGTERM
//! and SIGINT on Unix; Ctrl+C, Ctrl+Break, console close and system shutdown
//! on Windows) and, when a supervisor holds its stdin, from [`StdinLease`].
//! Windows services run detached, without a console, so a controller asks
//! them to stop through their control endpoint instead (see
//! `instance::request_stop`).

#[cfg(feature = "test-support")]
pub mod usage;

use std::io;
use std::process::{Command, ExitStatus};

/// Linux refuses exec while another process holds the inode open for writing.
/// Callers may retry a failed spawn after the writer closes its handle.
pub fn is_executable_busy(error: &io::Error) -> bool {
    #[cfg(target_os = "linux")]
    {
        error.raw_os_error() == Some(26) // ETXTBSY
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = error;
        false
    }
}

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

/// Whether this host has POSIX signals: a stop request is SIGTERM, a forced
/// stop SIGKILL, and [`terminating_signal`] reports the signal that ended a
/// process. Without them (Windows) a forced stop is an exit code.
pub const SIGNALS: bool = sys::SIGNALS;

/// The variables a sanitized child environment keeps from its parent: what a
/// program needs to find the user, the shell and executables on this host
/// (the MCP SDK's default inherited environment).
pub const BASELINE_ENVIRONMENT: &[&str] = sys::BASELINE_ENVIRONMENT;

/// The variables any program needs from its parent to start at all on this
/// host, which a cleared test environment passes on: none on Unix; the
/// system folders, the command interpreter and the executable search path on
/// Windows (Winsock, for one, fails without `SystemRoot`).
pub const SYSTEM_ENVIRONMENT: &[&str] = sys::SYSTEM_ENVIRONMENT;

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
    /// This host has no process-group signals (see [`CONTAINS_PROCESS_TREES`];
    /// every supported host has them now).
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

/// Puts the command `child` (started from a command prepared with
/// [`isolate_group`]) in its own containment, so [`signal_group`] reaches
/// everything it starts: a no-op on Unix, where the process group already
/// does; a Job Object on Windows. A command that cannot be contained must be
/// stopped by the caller, not run uncontained.
pub fn contain(child: &tokio::process::Child) -> io::Result<()> {
    sys::contain_tokio(child)
}

/// [`contain`] for a child started with the standard library.
pub fn contain_std(child: &std::process::Child) -> io::Result<()> {
    sys::contain_std(child)
}

/// Signals the process group led by `pid` (the Job Object of the command
/// `pid` on Windows). A group that no longer exists, or whose remaining
/// members are all zombies, is already stopped. Pid 0 (the caller's own
/// group) and ids outside the host's range are refused.
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

/// Whether `kill(target, 0)` finds a target, with POSIX targets: a positive
/// id names a process, 0 the caller's process group, -1 every process the
/// caller may signal, and another negative id the process group of its
/// absolute value. This is what Node's `process.kill(target, 0)` probed, for
/// ids the JavaScript runtime persisted. Windows answers positive ids like
/// [`liveness`] and nothing else ([`Liveness::Unknown`]).
pub fn target_liveness(target: i32) -> Liveness {
    sys::target_liveness(target)
}

/// Makes `command` start detached from this process, so it keeps running
/// after the caller exits and a stop aimed at the caller (a terminal's Ctrl+C)
/// does not reach it: a new process group on Unix; a new process group
/// without a console (`DETACHED_PROCESS`) on Windows.
pub fn detach(command: &mut Command) -> &mut Command {
    sys::detach(command)
}

/// Keep a detached child from retaining this controller's inherited output
/// pipes in addition to its explicitly redirected streams. Unix is unchanged.
pub fn prepare_detached_spawn() -> io::Result<()> {
    sys::prepare_detached_spawn()
}

/// Prevent a background child with redirected streams from allocating a Windows
/// console. Unix keeps the existing process-group and signal behavior.
pub fn hide_console(command: &mut Command) -> &mut Command {
    sys::hide_console(command)
}

/// A stop request the host delivered to this process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShutdownRequest {
    /// SIGINT, or Ctrl+C on Windows.
    Interrupt,
    /// SIGTERM, or Ctrl+Break, console close or system shutdown on Windows.
    Terminate,
}

/// The stop requests the host delivers to this process, from the moment
/// [`shutdown_requests`] returns: the requests no longer run their default
/// action (ending the process), so the caller must act on them.
#[derive(Debug)]
pub struct ShutdownRequests(sys::ShutdownRequests);

impl ShutdownRequests {
    /// Resolves at the next stop request.
    pub async fn recv(&mut self) -> ShutdownRequest {
        self.0.recv().await
    }
}

/// Starts listening for the host's stop requests (see [`ShutdownRequests`]).
/// Must be called within a Tokio runtime.
pub fn shutdown_requests() -> io::Result<ShutdownRequests> {
    sys::shutdown_requests().map(ShutdownRequests)
}

/// [`shutdown_requests`] for a process that serves a session over its stdio
/// (the MCP server): on Unix, SIGHUP (its terminal closed) and SIGPIPE (its
/// peer went away) are stop requests too.
pub fn session_shutdown_requests() -> io::Result<ShutdownRequests> {
    sys::session_shutdown_requests().map(ShutdownRequests)
}

/// A supervisor's lease on this process, carried by its stdin pipe: the
/// supervisor holds the write end while it wants the process to run and
/// closes it (or exits) to release it.
#[derive(Debug)]
pub struct StdinLease(sys::StdinLease);

impl StdinLease {
    /// Watches stdin for the end of the lease. Unix reads a non-blocking
    /// duplicate of it on the Tokio reactor; Windows reads it on a thread of
    /// its own. Must be called within a Tokio runtime.
    pub fn capture() -> io::Result<Self> {
        sys::StdinLease::capture().map(Self)
    }

    /// Resolves once the supervisor has released the lease (stdin reached
    /// its end); bytes written to it are ignored.
    pub async fn closed(&self) -> io::Result<()> {
        self.0.closed().await
    }
}
