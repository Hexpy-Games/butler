//! Process control of the agent child and the exit statuses the harness
//! collected: every intentional stop must exit 0 and a crash must not, since
//! launchd (`KeepAlive: {SuccessfulExit: false}`) and systemd
//! (`Restart=on-failure`) restart only an Agent that exits non-zero.

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use butler_platform::instance::{StopError, request_stop};

use super::Agent;
use crate::e2e::{HarnessError, harness_error};

impl Agent {
    /// Starts the agent process without waiting for its gateway (the process
    /// must not be running); returns its PID.
    pub fn start_process(&mut self) -> Result<u32, HarnessError> {
        if self.child.is_some() {
            return Err(harness_error("start_process while the agent is running"));
        }
        self.launch_child()?;
        self.pid()
            .ok_or_else(|| harness_error("the started agent has no PID"))
    }

    /// SIGKILL: no drain, no shutdown hooks.
    pub fn kill9(&mut self) -> Result<(), HarnessError> {
        if let Some(mut child) = self.child.take() {
            child.kill()?;
            let status = child.wait()?;
            self.exits.push((child.id(), status));
        }
        Ok(())
    }

    /// A stop request (SIGTERM) and wait for exit (bounded). It is a
    /// requested stop, so the process must exit 0: launchd (`SuccessfulExit:
    /// false`) and systemd (`Restart=on-failure`) restart an Agent that exits
    /// otherwise. A host without stop signals (Windows) stops the agent
    /// through `butler stop`, which announces the stop and delivers it to the
    /// instance's control endpoint.
    pub async fn terminate(&mut self) -> Result<(), HarnessError> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        if let Err(StopError::Unsupported) = request_stop(child.id()) {
            let stop = self.cli(&["stop", "--json"])?;
            if stop.code != Some(0) {
                child.kill()?;
                child.wait()?;
                return Err(harness_error(format!(
                    "butler stop failed: {} {}",
                    stop.stdout, stop.stderr
                )));
            }
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = child.try_wait()? {
                self.exits.push((child.id(), status));
                if status.code() != Some(0) {
                    return Err(harness_error(format!(
                        "agent exited with {status} after SIGTERM; a requested stop must exit 0"
                    )));
                }
                return Ok(());
            }
            if Instant::now() > deadline {
                child.kill()?;
                child.wait()?;
                return Err(harness_error("agent did not exit within 30s of SIGTERM"));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Collects an exited process so the agent can be started again; returns
    /// its exit status when there was one to collect.
    pub fn reap(&mut self) -> Option<ExitStatus> {
        let mut child = self.child.take()?;
        let status = child.wait().ok()?;
        self.exits.push((child.id(), status));
        Some(status)
    }

    /// The exit status of the child `pid`, once the harness has reaped it.
    pub fn exit_status(&self, pid: u32) -> Option<ExitStatus> {
        self.exits
            .iter()
            .rev()
            .find(|(exited, _)| *exited == pid)
            .map(|(_, status)| *status)
    }
}

/// Points the command's output at fresh files in `dir`, not pipes: a
/// replacement service the command starts may keep a pipe's write end open
/// (Windows children inherit every inheritable handle), which would hold a
/// pipe reader until that service exits. Returns the stdout and stderr paths.
pub(super) fn capture_to_files(
    command: &mut Command,
    dir: &Path,
) -> Result<(PathBuf, PathBuf), HarnessError> {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    std::fs::create_dir_all(dir)?;
    let stdout = dir.join(format!("cli-{id}.stdout"));
    let stderr = dir.join(format!("cli-{id}.stderr"));
    command
        .stdin(Stdio::null())
        .stdout(File::create(&stdout)?)
        .stderr(File::create(&stderr)?);
    Ok((stdout, stderr))
}

/// Every regular file under `dir`, concatenated (lossy UTF-8).
pub fn read_all(dir: &Path) -> String {
    let mut out = String::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.push_str(&read_all(&path));
        } else if let Ok(bytes) = fs::read(&path) {
            out.push_str(&String::from_utf8_lossy(&bytes));
            out.push('\n');
        }
    }
    out
}
