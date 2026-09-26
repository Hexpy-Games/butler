use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::btcc::{
    AdapterOutcome, BtccError, EffectAdapter, EffectAdapterError, EffectError, EffectFuture,
    PlanBinding,
};
use crate::context::NativeToolOutput;
use crate::workspace::{GuidedAccess, GuidedCommandInput, NativeCommands};

use super::{CommandScope, NativeGuidedCommand, PreparedCommandEffect, active_root, error, output};

pub(super) async fn prepare(
    owner: &NativeGuidedCommand,
    args: &Map<String, Value>,
    scope: CommandScope<'_>,
) -> Result<PreparedCommandEffect, BtccError> {
    let workspace = active_root(&scope)?;
    let guarded_root = workspace.clone();
    let requested = args.get("cwd").and_then(Value::as_str).map(str::to_owned);
    let cwd = owner
        .jobs
        .run(move || NativeCommands::guarded_directory(&guarded_root, requested.as_deref()))
        .await?
        .map_err(BtccError::from)?;
    let root_identity = canonical_root(&workspace);
    let cwd_identity = canonical_root(&cwd);
    let relative = cwd_identity
        .strip_prefix(&root_identity)
        .map_err(|_| error("command_cwd_rejected"))?;
    let relative = if relative.as_os_str().is_empty() {
        ".".to_owned()
    } else {
        relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    };
    let mut proposed = args.clone();
    proposed.insert("cwd".into(), Value::String(relative.clone()));
    let input = normalize(&Value::Object(proposed))
        .map_err(|e| BtccError::relayed("command_effect_invalid", e))?;
    let Some(effect) = input.get("state_effect").and_then(Value::as_str) else {
        return Err(error("command_effect_invalid"));
    };
    let target = target(&relative, effect);
    let adapter = CommandEffectAdapter {
        commands: owner.commands.clone(),
        output: owner.output.clone(),
        jobs: owner.jobs.clone(),
        host_environment: owner.host_environment.clone(),
        butler_data: scope.butler_data.to_path_buf(),
        workspace,
        root_identity,
        cwd,
        cwd_identity,
        target: target.clone(),
        effect: effect.to_owned(),
    };
    Ok(PreparedCommandEffect {
        target,
        input,
        adapter: Arc::new(adapter),
    })
}

struct CommandEffectAdapter {
    commands: NativeCommands,
    output: NativeToolOutput,
    jobs: super::jobs::CommandJobs,
    host_environment: Arc<HashMap<String, String>>,
    butler_data: PathBuf,
    workspace: PathBuf,
    root_identity: PathBuf,
    cwd: PathBuf,
    cwd_identity: PathBuf,
    target: String,
    effect: String,
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
    fn normalize_target(&self, target: &str) -> Result<String, crate::btcc::EffectFailure> {
        if target == self.target {
            Ok(target.to_owned())
        } else {
            Err(crate::btcc::EffectFailure::policy(
                "command_target_mismatch",
                "run_command effect target changed after workspace admission",
            ))
        }
    }
    fn sanitize_target(&self, target: &str) -> Result<String, crate::btcc::EffectFailure> {
        Ok(target.to_owned())
    }
    fn normalize_input(&self, input: &Value) -> Result<Value, crate::btcc::EffectFailure> {
        normalize(input).map_err(|message| {
            crate::btcc::EffectFailure::policy("command_effect_invalid", message)
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
            if canonical_root(&self.workspace) != self.root_identity
                || canonical_root(&self.cwd) != self.cwd_identity
            {
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
            let data = self.butler_data.clone();
            let before = self
                .jobs
                .run(move || super::artifacts::snapshot(&data))
                .await
                .map_err(|error| crate::btcc::EffectFailure::adapter(error.message()))?;
            let started = std::time::SystemTime::now();
            let spooled = self
                .commands
                .submit_guided(GuidedCommandInput {
                    command: command.into(),
                    cwd: Some(self.cwd.to_string_lossy().into_owned()),
                    workspace_root: self.root_identity.clone(),
                    butler_data: self.butler_data.clone(),
                    timeout_ms: args.get("timeout_ms").and_then(Value::as_f64),
                    access: GuidedAccess::FullAccessContained,
                    host_environment: (*self.host_environment).clone(),
                    abort: signal.clone(),
                })
                .map_err(|error| crate::btcc::EffectFailure::adapter(error.message()))?
                .await
                .map_err(|_| crate::btcc::EffectFailure::adapter("Command completion was lost"))?
                .map_err(|error| crate::btcc::EffectFailure::adapter(error.message()))?;
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
            .map_err(|error| crate::btcc::EffectFailure::adapter(error.message()))?;
            Ok(AdapterOutcome::Applied(result))
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

fn canonical_root(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
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
fn normalize(value: &Value) -> Result<Value, String> {
    let source = value
        .as_object()
        .ok_or("run_command effect input must be an object")?;
    let effect = source
        .get("state_effect")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "mutation" | "remote_observation"))
        .ok_or(
            "run_command persistent effect requires state_effect mutation or remote_observation",
        )?;
    let required = |key: &str| -> Result<&str, String> {
        source
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !crate::public_text::trim_js_whitespace(value).is_empty())
            .ok_or_else(|| format!("run_command {key} must be a non-empty string"))
    };
    let mut result = Map::new();
    result.insert("command".into(), Value::String(required("command")?.into()));
    result.insert("cwd".into(), Value::String(required("cwd")?.into()));
    result.insert("state_effect".into(), Value::String(effect.into()));
    if let Some(value) = source.get("validation_suite") {
        let raw = value
            .as_str()
            .ok_or("run_command validation_suite must be a string")?;
        let trimmed = crate::public_text::trim_js_whitespace(raw);
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
                .filter(|path| !crate::public_text::trim_js_whitespace(path).is_empty())
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
