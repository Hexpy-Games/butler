//! Source-shaped run_command binding over the process command and output owners.

mod artifacts;
mod effect;
mod evidence;
mod jobs;
mod ledger_guard;
mod output;
mod path_guard;
mod registered_artifacts;
mod structured_stdout;
pub(in crate::host) mod timing;
mod validation;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use butler_core::json::JsonDocument;
use butler_runtime::context::ToolOutput;
use butler_turn::btcc::BtccError;
use butler_turn::workspace::{
    Commands, GuidedAccess, GuidedCommandInput, LegacyShell, StructuredCommandInput,
    WorkspaceReference,
};
use jobs::CommandJobs;

#[derive(Clone)]
pub(crate) struct GuidedCommand {
    commands: Commands,
    output: ToolOutput,
    host_environment: Arc<HashMap<String, String>>,
    jobs: CommandJobs,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CommandExecution {
    Sandboxed,
    Registered,
}

#[derive(Clone)]
pub(crate) struct CommandScope<'a> {
    pub workspace_reference: Option<&'a WorkspaceReference>,
    pub workspace_path: &'a Path,
    pub butler_data: &'a Path,
    pub execution: CommandExecution,
    pub contained_reads: bool,
    pub abort: CancellationToken,
    pub allowed_tools_and_effects: Option<&'a [String]>,
    pub installation_root: Option<&'a Path>,
}

pub(crate) struct PreparedCommandEffect {
    pub target: String,
    pub input: Value,
    pub adapter: Arc<dyn butler_turn::btcc::EffectAdapter>,
}

impl GuidedCommand {
    pub(crate) fn new(
        commands: Commands,
        output: ToolOutput,
        host_environment: Arc<HashMap<String, String>>,
    ) -> Self {
        Self {
            commands,
            output,
            host_environment,
            jobs: CommandJobs::new(),
        }
    }

    pub(crate) async fn close(&self) {
        self.jobs.close().await;
    }

    pub(crate) async fn execute_observation(
        &self,
        args: &Map<String, Value>,
        scope: CommandScope<'_>,
    ) -> Result<JsonDocument, BtccError> {
        let timing = timing::CommandTiming::new("observation");
        let effect = args
            .get("state_effect")
            .and_then(Value::as_str)
            .unwrap_or("read_only");
        if effect != "read_only" && effect != "validation" {
            return Err(error(if effect == "remote_observation" {
                "command_remote_observation_requires_typed_effect"
            } else {
                "command_mutation_requires_typed_effect"
            }));
        }
        let registered = scope.execution == CommandExecution::Registered;
        if registered && !command_admitted(&scope) {
            return not_admitted();
        }
        let root = active_root(&scope)?;
        let raw_command = args
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| error("command_invalid"))?;
        if raw_command.is_empty()
            || (registered && butler_core::public_text::trim_js_whitespace(raw_command).is_empty())
        {
            return Err(error("command_invalid"));
        }
        let command = if registered {
            butler_core::public_text::trim_js_whitespace(raw_command)
        } else {
            raw_command
        };
        let cwd = args.get("cwd").and_then(Value::as_str).map(str::to_owned);
        let timeout_ms = if registered {
            Some(registered_timeout(args.get("timeout_ms")))
        } else {
            args.get("timeout_ms").and_then(Value::as_f64)
        };
        if registered {
            timing.mark("before_cwd_job");
            let guarded_root = root.clone();
            let requested = cwd.clone();
            let resolved_cwd = self
                .jobs
                .run(move || {
                    let _timing = timing::CommandTiming::new("registered_cwd");
                    Commands::guarded_directory(&guarded_root, requested.as_deref())
                })
                .await?
                .map_err(BtccError::from)?;
            timing.mark("before_guard");
            if let Some(rejected) = self.check_paths(args, &scope).await? {
                timing.mark("refused");
                return Ok(rejected);
            }
            let before_git = registered_artifacts::snapshot(
                &self.commands,
                &root,
                Arc::clone(&self.host_environment),
                scope.abort.clone(),
            )
            .await;
            let started = std::time::SystemTime::now();
            let generated = scope.butler_data.join("artifacts/generated");
            self.jobs
                .run(move || std::fs::create_dir_all(generated))
                .await?
                .map_err(|error| {
                    BtccError::relayed("command_artifact_directory_failed", error.to_string())
                        .with_source(error)
                })?;
            let data = scope.butler_data.to_path_buf();
            let host = Arc::clone(&self.host_environment);
            let environment = self
                .jobs
                .run(move || Commands::tool_environment(&host, &data))
                .await?
                .map_err(BtccError::from)?;
            let output_abort = scope.abort.clone();
            let result = self
                .commands
                .submit_structured(StructuredCommandInput {
                    steps: Vec::new(),
                    cwd: Some(resolved_cwd.clone()),
                    environment: environment
                        .into_iter()
                        .map(|(key, value)| (key, Some(value)))
                        .collect(),
                    host_environment: (*self.host_environment).clone(),
                    inherit_environment: false,
                    stdin: String::new(),
                    timeout_ms,
                    abort: scope.abort,
                    legacy: Some(LegacyShell {
                        command: command.into(),
                        pipefail: true,
                        read_only_installation_root: scope.installation_root.map(Path::to_path_buf),
                    }),
                })
                .map_err(BtccError::from)?
                .await
                .map_err(|source| error("command_completion_lost").with_source(source))?;
            return output::registered_result(
                output::OutputResources {
                    output: &self.output,
                    jobs: &self.jobs,
                },
                command.into(),
                resolved_cwd.to_string_lossy().into_owned(),
                result,
                output::OutputOrigin {
                    inventory: scope.workspace_reference.and_then(|r| r.read_inventory()),
                    args,
                    workspace: &root,
                    data_root: scope.butler_data,
                    started,
                },
                output::RegisteredContext {
                    before_git,
                    commands: &self.commands,
                    host_environment: Arc::clone(&self.host_environment),
                    abort: output_abort,
                },
            )
            .await;
        }
        let data = scope.butler_data.to_path_buf();
        let inventory = scope.workspace_reference.and_then(|r| r.read_inventory());
        let before = Some(
            self.jobs
                .run(move || {
                    let inventory = inventory.unwrap_or_else(|| {
                        butler_platform::secure_fs::SecretInventory::cached(&data)
                    });
                    artifacts::snapshot(&data, &inventory)
                })
                .await?,
        );
        let started = std::time::SystemTime::now();
        let input = GuidedCommandInput {
            command: command.to_owned(),
            cwd,
            workspace_root: root.clone(),
            butler_data: scope.butler_data.to_path_buf(),
            timeout_ms,
            access: observation_access(scope.contained_reads),
            host_environment: (*self.host_environment).clone(),
            abort: scope.abort,
        };
        let spooled = self
            .commands
            .submit_guided(input)
            .map_err(BtccError::from)?
            .await
            .map_err(|source| error("command_completion_lost").with_source(source))?
            .map_err(BtccError::from)?;
        output::public_result(
            output::OutputResources {
                output: &self.output,
                jobs: &self.jobs,
            },
            spooled,
            output::OutputOrigin {
                inventory: scope.workspace_reference.and_then(|r| r.read_inventory()),
                args,
                workspace: &root,
                data_root: scope.butler_data,
                started,
            },
            before,
            None,
        )
        .await
    }

    /// `project_write`: the access decision allowed this mutation only inside
    /// the project-write sandbox (Auto), so it runs there.
    pub(crate) async fn prepare_effect(
        &self,
        args: &Map<String, Value>,
        scope: CommandScope<'_>,
        project_write: bool,
    ) -> Result<PreparedCommandEffect, BtccError> {
        effect::prepare(self, args, scope, project_write).await
    }
}

fn active_root(scope: &CommandScope<'_>) -> Result<PathBuf, BtccError> {
    match scope.workspace_reference {
        Some(reference) => reference
            .get()
            .map_err(|error| BtccError::relayed(error.code(), error.code())),
        None => Ok(scope.workspace_path.to_path_buf()),
    }
}

fn registered_timeout(value: Option<&Value>) -> f64 {
    let Some(value) = value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
    else {
        return 30_000.0;
    };
    value.clamp(1_000.0, 300_000.0)
}

fn error(code: &'static str) -> BtccError {
    BtccError::relayed(code, code)
}

fn observation_access(contained: bool) -> GuidedAccess {
    if contained {
        GuidedAccess::ContainedObservation
    } else {
        GuidedAccess::ReadOnlyObservation
    }
}

fn command_admitted(scope: &CommandScope<'_>) -> bool {
    scope
        .allowed_tools_and_effects
        .is_none_or(|allowed| allowed.iter().any(|name| name == "run_command:workspace"))
}

fn not_admitted() -> Result<JsonDocument, BtccError> {
    JsonDocument::from_value(&serde_json::json!({
        "ok": false, "error": "tool_not_admitted",
        "message": "Running commands is not allowed for this task.",
        "recovery_hint": "Use only the changes this task allows."
    }))
    .map_err(|source| error("command_result_encoding_failed").with_source(source))
}

fn directory_path_form(contained: bool) -> butler_turn::workspace::PathForm {
    if contained {
        butler_turn::workspace::PathForm::Contained
    } else {
        butler_turn::workspace::PathForm::RelativeOrAbsolute
    }
}
