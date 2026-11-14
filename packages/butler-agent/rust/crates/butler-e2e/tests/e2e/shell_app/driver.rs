//! Shared native App harness driver.
use super::*;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::process::{Child, ChildStdin};

pub(crate) const SHOTS: &str = "BUTLER_SHELL_SHOTS_EXECUTABLE";
/// The App's port for these runs (never the owner's 18765 or the demo's 19765).
const PORT: &str = "28765";

/// One App on the fixed port at a time.
pub(crate) static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The headless shell, started as the App on the sandbox's data folder.
pub(crate) struct Shell {
    child: Child,
    input: ChildStdin,
    output: BufReader<tokio::fs::File>,
    /// Where the harness writes its reports.
    out: PathBuf,
    pub(super) launch: Launch,
    browser: Option<Value>,
}

impl Shell {
    pub(crate) async fn start(
        sandbox: &Sandbox,
        env: &[(&str, String)],
    ) -> Result<Self, HarnessError> {
        let shots = PathBuf::from(nonempty(SHOTS).unwrap_or_default());
        let mut launch = Launch::new(sandbox)?;
        // The Agent the App starts creates its own token in the data folder.
        launch.use_data_folder_token();
        launch.set_env("BUTLER_APP_SERVER_PORT", PORT);
        launch.set_env("BUTLER_APP_DISABLE_SHELL_REGISTRATION", "1");
        let agent = sandbox.binary.display().to_string();
        launch.set_env("BUTLER_NATIVE_AGENT_EXECUTABLE", agent);
        for (key, value) in env {
            launch.set_env(key, value.clone());
        }
        let out = sandbox.root.join("shell");
        std::fs::create_dir_all(&out)?;
        let stdout = sandbox.logs.join("shell.stdout");
        let mut command = launch.env_command(&shots);
        command
            .arg(&out)
            .arg("--data")
            .arg(&sandbox.data)
            .arg("--app")
            .stdin(Stdio::piped())
            .stdout(std::fs::File::create(&stdout)?)
            .stderr(std::fs::File::create(sandbox.logs.join("shell.stderr"))?);
        let mut child = tokio::process::Command::from(command)
            .kill_on_drop(true)
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| harness_error("shell stdin"))?;
        let output = BufReader::new(tokio::fs::File::open(&stdout).await?);
        let mut shell = Self {
            child,
            input,
            output,
            out,
            launch,
            browser: None,
        };
        shell.ack("LIVE READY").await?;
        Ok(shell)
    }

    /// Reads the harness's output until `expected`; anything else (the Agent's own output
    /// included) is echoed.
    async fn ack(&mut self, expected: &str) -> Result<(), HarnessError> {
        let wait = async {
            let mut line = String::new();
            loop {
                if self.output.read_line(&mut line).await? == 0 {
                    if self.child.try_wait()?.is_some() {
                        return Err(harness_error(format!("shell exited before {expected}")));
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                }
                if !line.ends_with('\n') {
                    continue;
                }
                if line.trim() == expected {
                    return Ok(());
                }
                if let Some(raw) = line.trim().strip_prefix("LIVE BROWSER ") {
                    self.browser = Some(serde_json::from_str(raw)?);
                }
                print!("{line}");
                line.clear();
            }
        };
        tokio::time::timeout(Duration::from_secs(150), wait)
            .await
            .map_err(|_| harness_error(format!("shell: no {expected}")))?
    }

    pub(crate) async fn run(&mut self, commands: &[&str]) -> Result<(), HarnessError> {
        for command in commands {
            self.input
                .write_all(format!("{command}\n").as_bytes())
                .await?;
            self.ack("LIVE OK")
                .await
                .map_err(|error| harness_error(format!("{command}: {error}")))?;
        }
        Ok(())
    }

    pub(crate) async fn browser_state(&mut self) -> Result<Value, HarnessError> {
        self.run(&["browser-state"]).await?;
        self.browser
            .clone()
            .ok_or_else(|| harness_error("no browser state"))
    }

    /// A report the harness wrote (`diagnostics <name>`, `app-quit`).
    pub(crate) fn report(&self, name: &str) -> Result<Value, HarnessError> {
        Ok(serde_json::from_slice(&std::fs::read(
            self.out.join(format!("{name}.json")),
        )?)?)
    }

    /// The harness exits by itself after `quit`.
    pub(crate) async fn finish(mut self) -> Result<(), HarnessError> {
        self.input.write_all(b"quit\n").await?;
        let status = tokio::time::timeout(Duration::from_secs(10), self.child.wait())
            .await
            .map_err(|_| harness_error("shell did not exit"))??;
        if !status.success() {
            return Err(harness_error(format!("shell exited with {status}")));
        }
        Ok(())
    }
}
