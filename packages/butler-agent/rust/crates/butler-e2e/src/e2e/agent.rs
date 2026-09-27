//! The `butler-agent` process: spawn with an isolated environment, wait for
//! the gateway, SIGKILL / SIGTERM, restart on the same data dir and port, and
//! run CLI commands against the same data dir.

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use super::gateway::Gateway;
use super::sandbox::Sandbox;
use super::{HarnessError, harness_error};

/// Environment and layout needed to (re)start the agent.
#[derive(Clone)]
pub struct Launch {
    pub binary: PathBuf,
    pub install: PathBuf,
    pub resources: PathBuf,
    pub data: PathBuf,
    pub home: PathBuf,
    pub tmp: PathBuf,
    pub logs: PathBuf,
    pub port: u16,
    pub token: String,
    pub env: Vec<(String, String)>,
}

impl Launch {
    pub fn new(sandbox: &Sandbox) -> Result<Self, HarnessError> {
        let token = format!("e2e-gateway-{}", uuid::Uuid::new_v4().simple());
        let auth_file = sandbox.root.join("gateway-auth.json");
        fs::write(
            &auth_file,
            serde_json::json!({ "token": token }).to_string(),
        )?;
        let tmp = sandbox.root.join("tmp");
        fs::create_dir_all(&tmp)?;
        Ok(Self {
            binary: sandbox.binary.clone(),
            install: sandbox.install.clone(),
            resources: sandbox.resources.clone(),
            data: sandbox.data.clone(),
            home: sandbox.home.clone(),
            tmp,
            logs: sandbox.logs.clone(),
            port: free_port()?,
            token,
            env: vec![
                ("BUTLER_APP_LOCAL_AUTH_REQUIRED".into(), "1".into()),
                (
                    "BUTLER_APP_LOCAL_AUTH_FILE".into(),
                    auth_file.display().to_string(),
                ),
            ],
        })
    }

    pub fn set_env(&mut self, key: &str, value: impl Into<String>) {
        self.env.retain(|(existing, _)| existing != key);
        self.env.push((key.to_owned(), value.into()));
    }

    pub fn remove_env(&mut self, key: &str) {
        self.env.retain(|(existing, _)| existing != key);
    }

    /// Keeps the gateway token where the Butler App keeps it: in the data
    /// dir's App local-auth file, which the agent is pointed at. A CLI run
    /// without the local-auth variables then has only that file to go by.
    pub fn use_app_local_auth_file(&mut self) -> Result<PathBuf, HarnessError> {
        let path = self.data.join("app/runtime/auth/local-agent-auth.json");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = serde_json::json!({
            "schema": "butler.app-local-agent-auth.v1",
            "product": "butler-app",
            "purpose": "bundled-agent-local-auth",
            "token": self.token,
            "created_at": "2026-09-28T00:00:00.000Z",
            "raw_text_included": false,
        });
        fs::write(&path, file.to_string())?;
        self.set_env("BUTLER_APP_LOCAL_AUTH_FILE", path.display().to_string());
        Ok(path)
    }

    /// A command without the local-auth variables, as a user's terminal runs
    /// `butler` next to an App-started agent.
    pub fn command_without_local_auth(&self) -> Command {
        let mut command = self.command();
        command
            .env_remove("BUTLER_APP_LOCAL_AUTH_REQUIRED")
            .env_remove("BUTLER_APP_LOCAL_AUTH_FILE");
        command
    }

    /// A command for the agent binary with the scenario's isolated environment.
    pub fn command(&self) -> Command {
        let mut command = Command::new(&self.binary);
        command
            .arg("--installation-root")
            .arg(&self.install)
            .arg("--resource-root")
            .arg(&self.resources)
            .current_dir(&self.data)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("HOME", &self.home)
            .env("CODEX_HOME", self.home.join(".codex"))
            .env("TMPDIR", &self.tmp)
            .env("LANG", "en_US.UTF-8")
            .env("TZ", "UTC")
            .env("BUTLER_DATA", &self.data)
            .env("BUTLER_APP_SERVER_HOST", "127.0.0.1")
            .env("BUTLER_APP_SERVER_PORT", self.port.to_string())
            .env("BUTLER_METRICS_ENABLED", "0");
        for (key, value) in &self.env {
            command.env(key, value);
        }
        command
    }
}

/// A running agent. Killed (SIGKILL) on drop.
pub struct Agent {
    pub launch: Launch,
    child: Option<Child>,
    starts: u32,
}

impl Agent {
    pub async fn start(launch: Launch) -> Result<(Self, Gateway), HarnessError> {
        let mut agent = Self {
            launch,
            child: None,
            starts: 0,
        };
        let gateway = agent.spawn().await?;
        Ok((agent, gateway))
    }

    async fn spawn(&mut self) -> Result<Gateway, HarnessError> {
        self.starts += 1;
        let log = self.launch.logs.join(format!("agent-{}.log", self.starts));
        let stdout = File::create(&log)?;
        let stderr = stdout.try_clone()?;
        let child = self
            .launch
            .command()
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .spawn()?;
        self.child = Some(child);
        let gateway = Gateway::new(
            format!("http://127.0.0.1:{}", self.launch.port),
            self.launch.token.clone(),
        );
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            if gateway.healthy().await {
                return Ok(gateway);
            }
            if let Some(status) = self
                .child
                .as_mut()
                .and_then(|child| child.try_wait().ok().flatten())
            {
                let tail = fs::read_to_string(&log).unwrap_or_default();
                let tail: String = tail
                    .chars()
                    .rev()
                    .take(2000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
                return Err(harness_error(format!(
                    "agent exited ({status}) before its gateway was ready:\n{tail}"
                )));
            }
            if Instant::now() > deadline {
                return Err(harness_error("agent gateway not ready within 90s"));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.as_ref().map(Child::id)
    }

    /// SIGKILL: no drain, no shutdown hooks.
    pub fn kill9(&mut self) -> Result<(), HarnessError> {
        if let Some(mut child) = self.child.take() {
            child.kill()?;
            child.wait()?;
        }
        Ok(())
    }

    /// SIGTERM and wait for exit (bounded).
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
            if child.try_wait()?.is_some() {
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

    pub async fn restart(&mut self) -> Result<Gateway, HarnessError> {
        self.terminate().await?;
        self.spawn().await
    }

    /// Starts again after a crash or stop (the process must not be running).
    pub async fn start_again(&mut self) -> Result<Gateway, HarnessError> {
        if self.child.is_some() {
            return Err(harness_error("start_again while the agent is running"));
        }
        self.spawn().await
    }

    /// Collects an exited process so the agent can be started again.
    pub fn reap(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.wait();
        }
    }

    pub fn is_running(&mut self) -> bool {
        self.child
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
    }

    /// Concatenated stdout/stderr of every agent start in this scenario.
    pub fn logs(&self) -> String {
        read_all(&self.launch.logs)
    }

    /// Runs a CLI command that replaces the service process (`restart`,
    /// `stop`) while reaping the exiting child, as a supervisor would; an
    /// unreaped child stays a zombie that the product's identity probe cannot
    /// read.
    pub async fn cli_reaping(&mut self, args: &[&str]) -> Result<CliOutput, HarnessError> {
        let mut command = self.launch.command();
        command.args(args);
        self.command_reaping(command, || {}).await
    }

    /// [`Agent::cli_reaping`] for a prepared command (for example one with a
    /// changed environment); `observe` runs on every poll while it runs.
    pub async fn command_reaping(
        &mut self,
        mut command: Command,
        observe: impl FnMut(),
    ) -> Result<CliOutput, HarnessError> {
        command.stdin(Stdio::null());
        let output = self
            .while_reaping(move || command.output(), observe)
            .await??;
        Ok(CliOutput {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    /// Runs blocking `work` to completion while reaping the service child
    /// when it exits, as a supervisor would; `observe` runs about every 25 ms
    /// while `work` runs.
    pub async fn while_reaping<T: Send + 'static>(
        &mut self,
        work: impl FnOnce() -> T + Send + 'static,
        mut observe: impl FnMut(),
    ) -> Result<T, HarnessError> {
        let task = tokio::task::spawn_blocking(work);
        loop {
            observe();
            if let Some(child) = self.child.as_mut()
                && matches!(child.try_wait(), Ok(Some(_)))
            {
                self.child = None;
            }
            if task.is_finished() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        task.await.map_err(|error| harness_error(error.to_string()))
    }

    /// Runs `butler-agent <args>` (the `butler` CLI) against the same data dir.
    pub fn cli(&self, args: &[&str]) -> Result<CliOutput, HarnessError> {
        let output = self
            .launch
            .command()
            .args(args)
            .stdin(Stdio::null())
            .output()?;
        Ok(CliOutput {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Debug)]
pub struct CliOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl CliOutput {
    pub fn json(&self) -> Result<serde_json::Value, HarnessError> {
        serde_json::from_str(self.stdout.trim()).map_err(|error| {
            harness_error(format!(
                "CLI stdout is not JSON ({error}): {}\nstderr: {}",
                self.stdout, self.stderr
            ))
        })
    }
}

pub fn free_port() -> Result<u16, HarnessError> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port())
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
