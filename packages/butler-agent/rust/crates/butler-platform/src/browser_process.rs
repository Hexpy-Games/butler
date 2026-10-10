//! A Chromium process driven over the DevTools pipe (`--remote-debugging-pipe`).
//!
//! The browser reads DevTools messages from one pipe and writes replies and
//! events to another; no debugging port is opened. Unix hands the pipes over
//! as file descriptors 3 and 4 (the switch's contract) through a `/bin/sh`
//! `exec` with redirections, so this crate needs no `unsafe` pre-exec hook.
//! Windows passes two inheritable pipe handles with
//! `--remote-debugging-io-pipes=<read>,<write>`.
//!
//! The browser starts as the leader of its own process group (a Job Object on
//! Windows), so [`PipeBrowser::kill`] and dropping the handle end the whole
//! tree: renderers, GPU and utility processes included. Its output goes to a
//! log file, never to this process's stdio.

use std::ffi::OsString;
use std::io;
use std::path::Path;

use tokio::sync::mpsc;

#[cfg(feature = "test-support")]
mod test_support;
#[cfg(feature = "test-support")]
pub use test_support::matching_processes;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// The Chrome for Testing platform name of this host (`mac-arm64`,
/// `mac-x64`, `linux64`, `linux-arm64`, `win64`), or `None` where no build
/// is published.
pub fn chrome_for_testing_platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("mac-arm64"),
        ("macos", "x86_64") => Some("mac-x64"),
        ("linux", "x86_64") => Some("linux64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("windows", "x86_64") => Some("win64"),
        _ => None,
    }
}

/// The headless shell's executable file name on this host.
pub const HEADLESS_SHELL_EXECUTABLE: &str = sys::HEADLESS_SHELL_EXECUTABLE;

/// A running browser and its DevTools pipe.
pub struct PipeBrowser {
    pid: u32,
    /// Raw bytes the browser wrote; the channel closes when its pipe ends.
    /// Taken once by the protocol reader.
    pub incoming: Option<mpsc::Receiver<Vec<u8>>>,
    /// Raw bytes for the browser to read; NUL-separated DevTools messages.
    pub outgoing: mpsc::Sender<Vec<u8>>,
    guard: sys::Guard,
}

impl PipeBrowser {
    /// The browser's process id (the leader of its process tree).
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Ends the browser's whole process tree at once.
    pub fn kill(&mut self) {
        self.guard.kill();
    }
}

impl Drop for PipeBrowser {
    fn drop(&mut self) {
        self.guard.kill();
    }
}

/// Starts `program` with `args` (which must include `--remote-debugging-pipe`)
/// in a process tree of its own, its stdout and stderr appended to `log`.
/// Must be called within a Tokio runtime.
pub fn spawn(program: &Path, args: &[OsString], log: &Path) -> io::Result<PipeBrowser> {
    let (pid, incoming, outgoing, guard) = sys::spawn(program, args, log)?;
    Ok(PipeBrowser {
        pid,
        incoming: Some(incoming),
        outgoing,
        guard,
    })
}
