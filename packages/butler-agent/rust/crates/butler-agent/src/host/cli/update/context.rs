//! What the Agent package commands share: the data folder, the Agent home,
//! the launchers, and restarting the service on the version just activated.

use butler_platform::secure_fs::Canonical;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use butler_runtime::operations::{AgentHome, BINARY, LauncherState, RESOURCES, version_newer};
use serde_json::{Value, json};

use super::report::install_error;
use super::{Options, ResolvedInstallation, settings_cli};
use crate::host::cli::error::CliError;
use crate::host::cli::service;
use crate::host::service::cli_launcher;
use crate::host::service::instance::InstanceRecord;

/// How long a restart on the new version may take: stopping the old service,
/// then waiting for the new one to be ready.
const RESTART_TIMEOUT: Duration = Duration::from_secs(240);

/// An installation the service can be started from.
struct Runner {
    executable: PathBuf,
    root: PathBuf,
    resources: PathBuf,
}

pub(super) struct Context {
    pub(super) installation: ResolvedInstallation,
    pub(super) data_root: PathBuf,
    /// The data folder as named (`--data`, `BUTLER_DATA`, `~/.butler`), before
    /// its links were resolved.
    pub(super) requested_data: PathBuf,
    pub(super) home: AgentHome,
}

impl Context {
    pub(super) fn open(
        installation: ResolvedInstallation,
        options: &Options,
    ) -> Result<Self, CliError> {
        let data_root =
            settings_cli::resolve_data_root_override(options.data.clone(), &installation)
                .map_err(|_| CliError::failed("unsafe_path", "BUTLER_DATA is unavailable"))?;
        let home = AgentHome::resolve().map_err(|error| install_error(&error))?;
        let requested_data = options
            .data
            .clone()
            .or_else(|| {
                std::env::var_os("BUTLER_DATA")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
            })
            .unwrap_or_else(|| data_root.clone());
        Ok(Self {
            installation,
            data_root,
            requested_data,
            home,
        })
    }

    /// The version this machine runs: the running installation's, or the
    /// active version of the Agent home when that is newer (an App-bundled
    /// Agent updating the CLI installation next to it).
    pub(super) fn known_version(&self) -> Option<String> {
        let running = self.installation.agent_version();
        match (running, self.home.active_version()) {
            (Some(running), Some(installed)) if version_newer(&installed, &running) => {
                Some(installed)
            }
            (Some(running), _) => Some(running),
            (None, installed) => installed,
        }
    }

    /// Executables the service runs from, whose versions must not be pruned.
    pub(super) fn protected_executables(&self) -> Vec<PathBuf> {
        service::running_instance(&self.data_root)
            .ok()
            .flatten()
            .map(|record| {
                let executable = PathBuf::from(record.executable);
                executable.canonical().unwrap_or(executable)
            })
            .into_iter()
            .collect()
    }

    /// The service instance that runs now, if there is one.
    pub(super) fn running_record(&self) -> Option<InstanceRecord> {
        service::running_instance(&self.data_root).ok().flatten()
    }

    /// Points both launchers at the CLI installation.
    pub(super) fn refresh_launchers(&self) -> Value {
        let canonical = self
            .home
            .sync_command_launcher(None)
            .map(|sync| {
                json!({
                    "path": sync.path,
                    "state": match sync.state {
                        LauncherState::Written => "written",
                        LauncherState::Current => "current",
                        LauncherState::KeptForeign => "kept-foreign",
                    },
                    "onPath": on_path(&sync.path),
                })
            })
            .unwrap_or_else(|error| json!({"state": "failed", "code": error.code()}));
        // The data folder's launcher follows the Agent that serves it: the
        // CLI installation, unless the service runs another (the App's newer
        // bundled Agent), which its own start points the launcher at.
        let elsewhere = self
            .running_record()
            .is_some_and(|record| !self.home.contains(Path::new(&record.executable)));
        let data = if elsewhere {
            "kept"
        } else {
            cli_launcher::point_at_agent_home(&self.data_root, &self.home)
                .map_or("failed", |state| state.as_str())
        };
        json!({"command": canonical, "dataLauncher": data})
    }

    /// Restarts the service on `dir` when it is running; reports what
    /// happened. A stopped service stays stopped.
    ///
    /// The result says what runs afterwards, not what was asked for: an App
    /// that starts its own bundled Agent instead is reported as such
    /// (`onNewVersion: false`).
    pub(super) async fn restart_if_running(&self, dir: &str) -> Result<Value, CliError> {
        match service::running_instance(&self.data_root) {
            Ok(Some(_)) => {
                let restarted = self
                    .run_service_command(&self.runner_for(dir), "restart")
                    .await?;
                let record = self.running_record();
                let executable = record.as_ref().map(|record| record.executable.clone());
                let on_new_version = executable.as_deref().is_some_and(|executable| {
                    let version = self.home.version_path(dir);
                    let resolved =
                        |path: &Path| path.canonical().unwrap_or_else(|_| path.to_path_buf());
                    resolved(Path::new(executable)).starts_with(resolved(&version))
                });
                Ok(json!({
                    "wasRunning": true,
                    "restarted": true,
                    "pid": restarted["data"]["pid"],
                    "executable": executable,
                    "onNewVersion": on_new_version,
                }))
            }
            Ok(None) => Ok(json!({"wasRunning": false, "restarted": false})),
            Err(error) => Err(CliError::failed(
                "service_state_unavailable",
                error.message(),
            )),
        }
    }

    /// Puts back what a failed restart disturbed: the version that was active
    /// before, or, when none was, the installation the service was running
    /// from. The version just installed stops being active in that case, so
    /// no launcher runs it. Whether the service is up again.
    pub(super) async fn restore(
        &self,
        replaced: Option<&str>,
        before: Option<&InstanceRecord>,
    ) -> bool {
        let reactivated = replaced.filter(|previous| {
            self.home
                .lock()
                .and_then(|lock| lock.activate(previous))
                .is_ok()
        });
        let runner = match (reactivated, before) {
            (Some(previous), _) => self.runner_for(previous),
            (None, Some(record)) => {
                let deactivated = self.home.lock().and_then(|lock| lock.deactivate());
                drop(deactivated);
                self.runner_for_record(record)
            }
            (None, None) => return false,
        };
        let running = self.running_record().is_some();
        let verb = if running { "restart" } else { "start" };
        self.run_service_command(&runner, verb).await.is_ok()
    }

    /// The installation of version directory `dir`.
    fn runner_for(&self, dir: &str) -> Runner {
        let root = self.home.version_path(dir);
        Runner {
            executable: root.join(BINARY),
            resources: root.join(RESOURCES),
            root,
        }
    }

    /// The installation a running instance was started from: this process's
    /// own when that is the executable, else the standalone layout around it,
    /// else this process's.
    fn runner_for_record(&self, record: &InstanceRecord) -> Runner {
        let executable = PathBuf::from(&record.executable);
        let own = || Runner {
            executable: self.installation.executable().to_path_buf(),
            root: self.installation.root().to_path_buf(),
            resources: self.installation.resources().to_path_buf(),
        };
        if executable == self.installation.executable() {
            return own();
        }
        match executable.parent() {
            Some(root) if root.join(RESOURCES).is_dir() => Runner {
                resources: root.join(RESOURCES),
                root: root.to_path_buf(),
                executable,
            },
            _ => own(),
        }
    }

    /// Runs `<executable> <verb> --json` of `runner`, so the service that
    /// comes up is that installation's.
    async fn run_service_command(&self, runner: &Runner, verb: &str) -> Result<Value, CliError> {
        let dir = runner.root.display().to_string();
        let mut command = tokio::process::Command::new(&runner.executable);
        command
            .arg("--installation-root")
            .arg(&runner.root)
            .arg("--resource-root")
            .arg(&runner.resources)
            .args([verb, "--json", "--data"])
            .arg(&self.data_root)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        let output = tokio::time::timeout(RESTART_TIMEOUT, command.output())
            .await
            .map_err(|_| {
                CliError::failed(
                    "service_restart_timeout",
                    "the service did not come back in time",
                )
            })?
            .map_err(|error| {
                CliError::failed(
                    "service_restart_failed",
                    "the new version could not be started",
                )
                .with_source(error)
            })?;
        if output.status.success() {
            return Ok(serde_json::from_slice(&output.stdout).unwrap_or(Value::Null));
        }
        let detail = String::from_utf8_lossy(if output.stderr.is_empty() {
            &output.stdout
        } else {
            &output.stderr
        });
        let detail: String = detail
            .lines()
            .next()
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        Err(CliError::failed(
            "service_restart_failed",
            format!("the service did not restart on {dir}: {detail}"),
        ))
    }
}

/// Whether the directory of `launcher` is on this process's `PATH`.
fn on_path(launcher: &std::path::Path) -> bool {
    let Some(directory) = launcher.parent() else {
        return false;
    };
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|entry| entry == directory))
}
