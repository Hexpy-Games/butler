//! Process control of the agent child and the exit statuses the harness
//! collected: every intentional stop must exit 0 and a crash must not, since
//! launchd (`KeepAlive: {SuccessfulExit: false}`) and systemd
//! (`Restart=on-failure`) restart only an Agent that exits non-zero.

use std::process::ExitStatus;
use std::time::{Duration, Instant};

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

    /// SIGTERM and wait for exit (bounded). A SIGTERM is a stop request, so
    /// the process must exit 0: launchd (`SuccessfulExit: false`) and systemd
    /// (`Restart=on-failure`) restart an Agent that exits otherwise.
    pub async fn terminate(&mut self) -> Result<(), HarnessError> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        #[cfg(unix)]
        {
            let pid = nix::unistd::Pid::from_raw(i32::try_from(child.id()).unwrap_or(i32::MAX));
            let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGTERM);
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
