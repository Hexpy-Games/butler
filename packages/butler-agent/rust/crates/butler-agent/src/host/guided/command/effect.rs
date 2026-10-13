use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use butler_runtime::context::ToolOutput;
use butler_turn::btcc::{
    AdapterOutcome, BtccError, EffectAdapter, EffectAdapterError, EffectError, EffectFuture,
    PlanBinding,
};
use butler_turn::workspace::{Commands, GuidedAccess, GuidedCommandInput};

use super::{CommandScope, GuidedCommand, PreparedCommandEffect, active_root, error, output};

pub(super) async fn prepare(
    owner: &GuidedCommand,
    args: &Map<String, Value>,
    scope: CommandScope<'_>,
    project_write: bool,
) -> Result<PreparedCommandEffect, BtccError> {
    let workspace = active_root(&scope)?;
    let guarded_root = workspace.clone();
    let requested = args.get("cwd").and_then(Value::as_str).map(str::to_owned);
    let path_form = super::directory_path_form(scope.contained_reads);
    let (cwd, root_identity, cwd_identity) = owner
        .jobs
        .run(move || {
            let cwd = Commands::guarded_directory_in_scope(
                &guarded_root,
                requested.as_deref(),
                path_form,
            )?;
            let root_identity = canonical_root(&guarded_root);
            let cwd_identity = canonical_root(&cwd);
            Ok::<_, butler_turn::workspace::CommandError>((cwd, root_identity, cwd_identity))
        })
        .await?
        .map_err(BtccError::from)?;
    let directory = match butler_platform::secure_fs::relative_path(&cwd_identity, &root_identity) {
        Some(directory) => directory,
        None if scope.contained_reads => return Err(error("command_cwd_rejected")),
        None => cwd_identity.clone(),
    };
    let directory = if directory.as_os_str().is_empty() {
        ".".to_owned()
    } else {
        directory
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    };
    let mut proposed = args.clone();
    proposed
        .entry("state_effect")
        .or_insert_with(|| Value::String("read_only".into()));
    proposed.insert("cwd".into(), Value::String(directory.clone()));
    let input = normalize(&Value::Object(proposed))
        .map_err(|e| BtccError::relayed("command_effect_invalid", e.to_string()).with_source(e))?;
    let Some(effect) = input.get("state_effect").and_then(Value::as_str) else {
        return Err(error("command_effect_invalid"));
    };
    let target = target(&directory, effect);
    let adapter = CommandEffectAdapter {
        observation: owner.clone(),
        installation_root: scope.installation_root.map(Path::to_path_buf),
        allowed_tools_and_effects: scope.allowed_tools_and_effects.map(<[String]>::to_vec),
        commands: owner.commands.clone(),
        output: owner.output.clone(),
        jobs: owner.jobs.clone(),
        host_environment: owner.host_environment.clone(),
        butler_data: scope.butler_data.to_path_buf(),
        workspace,
        contained_reads: scope.contained_reads,
        root_identity,
        cwd,
        cwd_identity,
        target: target.clone(),
        effect: effect.to_owned(),
        project_write: project_write && effect == "mutation",
    };
    Ok(PreparedCommandEffect {
        target,
        input,
        adapter: Arc::new(adapter),
    })
}

struct CommandEffectAdapter {
    observation: GuidedCommand,
    installation_root: Option<PathBuf>,
    allowed_tools_and_effects: Option<Vec<String>>,
    commands: Commands,
    output: ToolOutput,
    jobs: super::jobs::CommandJobs,
    host_environment: Arc<HashMap<String, String>>,
    butler_data: PathBuf,
    workspace: PathBuf,
    contained_reads: bool,
    root_identity: PathBuf,
    cwd: PathBuf,
    cwd_identity: PathBuf,
    target: String,
    effect: String,
    /// Runs in the project-write sandbox instead of with full access.
    project_write: bool,
}

impl EffectAdapter for CommandEffectAdapter {
    fn capability(&self) -> &str {
        if self.effect == "remote_observation" {
            "run_command_remote_observation"
        } else {
            "run_command"
        }
    }
    fn binding(&self) -> PlanBinding {
        PlanBinding::AcceptedPlan
    }
    fn normalize_target(&self, target: &str) -> Result<String, butler_turn::btcc::EffectFailure> {
        if target == self.target {
            Ok(target.to_owned())
        } else {
            Err(butler_turn::btcc::EffectFailure::policy(
                "command_target_mismatch",
                "run_command effect target changed after workspace admission",
            ))
        }
    }
    fn sanitize_target(&self, target: &str) -> Result<String, butler_turn::btcc::EffectFailure> {
        Ok(target.to_owned())
    }
    fn normalize_input(&self, input: &Value) -> Result<Value, butler_turn::btcc::EffectFailure> {
        normalize(input).map_err(|message| {
            butler_turn::btcc::EffectFailure::policy("command_effect_invalid", message.to_string())
                .with_source(message)
        })
    }
    fn dispatch<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        _key: &'a str,
        signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if target != self.target {
                return Ok(AdapterOutcome::NotApplied(adapter_error(
                    "command_target_mismatch",
                    "The admitted command directory no longer matches the effect target.",
                )));
            }
            if signal.is_cancelled() {
                return Ok(AdapterOutcome::NotApplied(adapter_error(
                    "command_cancelled_before_dispatch",
                    "The command was cancelled before dispatch.",
                )));
            }
            let workspace = self.workspace.clone();
            let cwd = self.cwd.clone();
            let (root_identity, cwd_identity) = self
                .jobs
                .run(move || (canonical_root(&workspace), canonical_root(&cwd)))
                .await
                .map_err(|error| {
                    butler_turn::btcc::EffectFailure::adapter(error.message()).with_source(error)
                })?;
            if root_identity != self.root_identity || cwd_identity != self.cwd_identity {
                return Ok(AdapterOutcome::NotApplied(adapter_error(
                    "command_workspace_identity_changed",
                    "The approved command workspace or directory changed before dispatch.",
                )));
            }
            let Some((args, command)) = input.as_object().and_then(|args| {
                let command = args.get("command").and_then(Value::as_str)?;
                Some((args, command))
            }) else {
                return Ok(AdapterOutcome::NotApplied(adapter_error(
                    "command_effect_invalid",
                    "The approved command input is not a normalized command.",
                )));
            };
            self.run_admitted(args, command, signal).await
        })
    }
    fn reconcile<'a>(
        &'a self,
        _target: &'a str,
        _input: &'a Value,
        _key: &'a str,
        _signal: &'a CancellationToken,
        attempts: i64,
        _prior: Option<&'a EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if attempts == 0 {
                return Ok(AdapterOutcome::NotApplied(adapter_error(
                    "not_applied",
                    "not applied",
                )));
            }
            let code = if self.effect == "remote_observation" {
                "remote_observation_reconciliation_required"
            } else {
                "command_effect_reconciliation_required"
            };
            Ok(AdapterOutcome::Uncertain(Some(adapter_error(
                code,
                "The command may have run. Inspect the workspace or external target and report the uncertainty; do not repeat it blindly.",
            ))))
        })
    }
}

impl CommandEffectAdapter {
    async fn run_admitted(
        &self,
        args: &Map<String, Value>,
        command: &str,
        signal: &CancellationToken,
    ) -> Result<AdapterOutcome, butler_turn::btcc::EffectFailure> {
        if matches!(self.effect.as_str(), "read_only" | "validation") {
            let result = self
                .observation
                .execute_observation(
                    args,
                    CommandScope {
                        workspace_reference: None,
                        workspace_path: &self.workspace,
                        butler_data: &self.butler_data,
                        execution: super::CommandExecution::Registered,
                        contained_reads: self.contained_reads,
                        abort: signal.clone(),
                        allowed_tools_and_effects: self.allowed_tools_and_effects.as_deref(),
                        installation_root: self.installation_root.as_deref(),
                    },
                )
                .await
                .map_err(|error| {
                    butler_turn::btcc::EffectFailure::adapter(error.message()).with_source(error)
                })?;
            return Ok(AdapterOutcome::Applied(result));
        }
        if let Some(rejected) = self
            .observation
            .check_paths(
                args,
                &CommandScope {
                    workspace_reference: None,
                    workspace_path: &self.workspace,
                    butler_data: &self.butler_data,
                    execution: super::CommandExecution::Registered,
                    contained_reads: self.contained_reads,
                    abort: signal.clone(),
                    allowed_tools_and_effects: self.allowed_tools_and_effects.as_deref(),
                    installation_root: self.installation_root.as_deref(),
                },
            )
            .await
            .map_err(|error| {
                butler_turn::btcc::EffectFailure::adapter(error.message()).with_source(error)
            })?
        {
            return Ok(AdapterOutcome::Applied(rejected));
        }
        self.run_mutation(args, command, signal).await
    }

    async fn run_mutation(
        &self,
        args: &Map<String, Value>,
        command: &str,
        signal: &CancellationToken,
    ) -> Result<AdapterOutcome, butler_turn::btcc::EffectFailure> {
        let data = self.butler_data.clone();
        let before = self
            .jobs
            .run(move || super::artifacts::snapshot(&data))
            .await
            .map_err(|error| {
                butler_turn::btcc::EffectFailure::adapter(error.message()).with_source(error)
            })?;
        let started = std::time::SystemTime::now();
        let spooled = self
            .commands
            .submit_guided(GuidedCommandInput {
                command: command.into(),
                cwd: Some(self.cwd.to_string_lossy().into_owned()),
                workspace_root: self.root_identity.clone(),
                butler_data: self.butler_data.clone(),
                timeout_ms: args.get("timeout_ms").and_then(Value::as_f64),
                access: if self.project_write {
                    GuidedAccess::ProjectWrite
                } else {
                    GuidedAccess::FullAccessContained
                },
                host_environment: (*self.host_environment).clone(),
                abort: signal.clone(),
            })
            .map_err(|error| {
                butler_turn::btcc::EffectFailure::adapter(error.message()).with_source(error)
            })?
            .await
            .map_err(|source| {
                butler_turn::btcc::EffectFailure::adapter("Command completion was lost")
                    .with_source(source)
            })?
            .map_err(|error| {
                butler_turn::btcc::EffectFailure::adapter(error.message()).with_source(error)
            })?;
        let effect = if self.effect == "remote_observation" {
            "remote_observation"
        } else {
            "command_mutation"
        };
        let result = output::public_result(
            output::OutputResources {
                output: &self.output,
                jobs: &self.jobs,
            },
            spooled,
            output::OutputOrigin {
                args,
                workspace: &self.root_identity,
                data_root: &self.butler_data,
                started,
            },
            Some(before),
            Some(effect),
        )
        .await
        .map_err(|error| {
            butler_turn::btcc::EffectFailure::adapter(error.message()).with_source(error)
        })?;
        if self.project_write {
            return project_write_result(&result).map(AdapterOutcome::Applied);
        }
        Ok(AdapterOutcome::Applied(result))
    }
}

/// Labels the project-write sandbox and, when the command failed, tells the
/// model how to get the access the sandbox withheld (the user is asked).
fn project_write_result(
    result: &butler_core::json::JsonDocument,
) -> Result<butler_core::json::JsonDocument, butler_turn::btcc::EffectFailure> {
    let failure = |error: butler_core::json::JsonError| {
        butler_turn::btcc::EffectFailure::adapter("command_result_encoding_failed")
            .with_source(error)
    };
    let mut value: Value = serde_json::from_str(result.as_str()).map_err(|error| {
        butler_turn::btcc::EffectFailure::adapter("command_result_encoding_failed")
            .with_source(error)
    })?;
    value["sandbox"] = "project_write".into();
    if value["ok"] == false {
        value["next_action"] = "This command ran contained to the project folder: no writes elsewhere (including .git and secrets) and no network. If it needs those, run it again with sandbox \"none\"; the user will be asked.".into();
    }
    butler_core::json::JsonDocument::from_value(&value).map_err(failure)
}

fn canonical_root(path: &Path) -> PathBuf {
    butler_platform::secure_fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
fn target(cwd: &str, effect: &str) -> String {
    if effect == "remote_observation" {
        format!("remote-observation-command:{cwd}")
    } else {
        format!("workspace-command:{cwd}")
    }
}
fn adapter_error(code: &str, message: &str) -> EffectAdapterError {
    EffectAdapterError::new(code, message)
}
fn normalize(value: &Value) -> Result<Value, crate::host::HostError> {
    let source = value
        .as_object()
        .ok_or("run_command effect input must be an object")?;
    let effect = source
        .get("state_effect")
        .and_then(Value::as_str)
        .filter(|value| {
            matches!(
                *value,
                "mutation" | "remote_observation" | "read_only" | "validation"
            )
        })
        .ok_or("run_command requires a valid state_effect")?;
    let required = |key: &str| -> Result<&str, crate::host::HostError> {
        source
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !butler_core::public_text::trim_js_whitespace(value).is_empty())
            .ok_or_else(|| format!("run_command {key} must be a non-empty string"))
            .map_err(crate::host::HostError::from)
    };
    let mut result = Map::new();
    result.insert("command".into(), Value::String(required("command")?.into()));
    result.insert("cwd".into(), Value::String(required("cwd")?.into()));
    result.insert("state_effect".into(), Value::String(effect.into()));
    if let Some(value) = source.get("validation_suite") {
        let raw = value
            .as_str()
            .ok_or("run_command validation_suite must be a string")?;
        let trimmed = butler_core::public_text::trim_js_whitespace(raw);
        if !trimmed.is_empty() {
            result.insert("validation_suite".into(), Value::String(trimmed.into()));
        }
    }
    for key in ["timeout_ms", "max_output_tokens"] {
        if let Some(value) = source.get(key) {
            let number = value
                .as_f64()
                .filter(|number| number.is_finite() && *number > 0.0)
                .ok_or_else(|| format!("run_command {key} must be a positive number"))?;
            result.insert(key.into(), Value::from(number.trunc()));
        }
    }
    if let Some(value) = source.get("output_paths") {
        let paths = value
            .as_array()
            .ok_or("run_command output_paths must be an array")?;
        let mut normalized = Vec::with_capacity(paths.len());
        for path in paths {
            let raw = path
                .as_str()
                .filter(|path| !butler_core::public_text::trim_js_whitespace(path).is_empty())
                .ok_or("run_command output path must be a non-empty string")?;
            normalized.push(Value::String(raw.into()));
        }
        result.insert("output_paths".into(), Value::Array(normalized));
    }
    if let Some(value) = source.get("output_mode") {
        let raw = value
            .as_str()
            .filter(|mode| matches!(*mode, "auto" | "silent_on_success" | "full"))
            .ok_or("run_command output_mode is invalid")?;
        result.insert("output_mode".into(), Value::String(raw.into()));
    }
    Ok(Value::Object(result))
}
