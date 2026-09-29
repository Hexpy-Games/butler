//! What the Agent package commands share: the data folder, the Agent home,
//! the launchers, and restarting the service on the version just activated.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use butler_runtime::operations::{AgentHome, BINARY, LauncherState, RESOURCES, version_newer};
use serde_json::{Value, json};

use super::report::install_error;
use super::{Options, ResolvedInstallation, settings_cli};
use crate::host::cli::error::CliError;
use crate::host::cli::service;
use crate::host::service::cli_launcher;

/// How long a restart on the new version may take: stopping the old service,
/// then waiting for the new one to be ready.
const RESTART_TIMEOUT: Duration = Duration::from_secs(240);

pub(super) struct Context {
    pub(super) installation: ResolvedInstallation,
    pub(super) data_root: PathBuf,
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
        Ok(Self {
            installation,
            data_root,
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
            .map(|record| PathBuf::from(record.executable))
            .into_iter()
            .collect()
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
        let data = cli_launcher::point_at_agent_home(&self.data_root, &self.home)
            .map_or("failed", |state| state.as_str());
        json!({"command": canonical, "dataLauncher": data})
    }

    /// Restarts the service on `dir` when it is running; reports what
    /// happened. A stopped service stays stopped.
    pub(super) async fn restart_if_running(&self, dir: &str) -> Result<Value, CliError> {
        match service::running_instance(&self.data_root) {
            Ok(Some(_)) => {
                let restarted = self.run_service_command(dir, "restart").await?;
                Ok(json!({"wasRunning": true, "restarted": true, "pid": restarted["data"]["pid"]}))
            }
            Ok(None) => Ok(json!({"wasRunning": false, "restarted": false})),
            Err(error) => Err(CliError::failed(
                "service_state_unavailable",
                error.message(),
            )),
        }
    }

    /// Brings the service up on `dir` after a failed restart: restarts it if
    /// something is running, else starts it.
    pub(super) async fn ensure_running(&self, dir: &str) -> Result<(), CliError> {
        let running = matches!(service::running_instance(&self.data_root), Ok(Some(_)));
        let verb = if running { "restart" } else { "start" };
        self.run_service_command(dir, verb).await.map(|_| ())
    }

    /// Runs `butler-agent <verb> --json` from the version directory `dir`, so
    /// the service that comes up is that version's.
    async fn run_service_command(&self, dir: &str, verb: &str) -> Result<Value, CliError> {
        let root = self.home.version_path(dir);
        let mut command = tokio::process::Command::new(root.join(BINARY));
        command
            .arg("--installation-root")
            .arg(&root)
            .arg("--resource-root")
            .arg(root.join(RESOURCES))
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
