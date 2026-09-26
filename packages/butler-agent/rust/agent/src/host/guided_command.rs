//! Source-shaped run_command binding over the process command and output owners.

mod artifacts;
mod effect;
mod evidence;
mod jobs;
mod ledger_guard;
mod output;
mod registered_artifacts;
mod structured_stdout;
mod validation;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::btcc::{AccessMode, BtccError};
use crate::context::NativeToolOutput;
use crate::json::JsonDocument;
use crate::workspace::{
    GuidedAccess, GuidedCommandInput, LegacyShell, NativeCommands, StructuredCommandInput,
    WorkspaceReference,
};
use jobs::CommandJobs;

pub(crate) struct NativeGuidedCommand {
    commands: NativeCommands,
    output: NativeToolOutput,
    host_environment: Arc<HashMap<String, String>>,
    jobs: CommandJobs,
}

pub(crate) struct CommandScope<'a> {
    pub workspace_reference: Option<&'a WorkspaceReference>,
    pub workspace_path: &'a Path,
    pub butler_data: &'a Path,
    pub access_mode: AccessMode,
    pub abort: CancellationToken,
    pub allowed_tools_and_effects: Option<&'a [String]>,
    pub installation_root: Option<&'a Path>,
}

pub(crate) struct PreparedCommandEffect {
    pub target: String,
    pub input: Value,
    pub adapter: Arc<dyn crate::btcc::EffectAdapter>,
}

impl NativeGuidedCommand {
    pub(crate) fn new(
        commands: NativeCommands,
        output: NativeToolOutput,
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
        let registered = scope.access_mode == AccessMode::FullAccess;
        if registered
            && scope
                .allowed_tools_and_effects
                .is_some_and(|allowed| !allowed.iter().any(|name| name == "run_command:workspace"))
        {
            return JsonDocument::from_value(&serde_json::json!({
                "ok": false, "error": "tool_not_admitted",
                "message": "Command execution is not admitted for this Steward task.",
                "recovery_hint": "Use only the exact mutation capability in the delegated packet."
            }))
            .map_err(|_| error("command_result_encoding_failed"));
        }
        let root = active_root(&scope)?;
        let raw_command = args
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| error("command_invalid"))?;
        if raw_command.is_empty()
            || (registered && crate::public_text::trim_js_whitespace(raw_command).is_empty())
        {
            return Err(error("command_invalid"));
        }
        let command = if registered {
            crate::public_text::trim_js_whitespace(raw_command)
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
            let guarded_root = root.clone();
            let requested = cwd.clone();
            let resolved_cwd = self
                .jobs
                .run(move || NativeCommands::guarded_directory(&guarded_root, requested.as_deref()))
                .await?
                .map_err(|e| BtccError::new(e.code, e.message))?;
            let guard_command = command.to_owned();
            let guard_cwd = resolved_cwd.clone();
            let guard_root = root.clone();
            let guard_data = scope.butler_data.to_path_buf();
            let guard_installation_root = scope.installation_root.map(Path::to_path_buf);
            let guard_home = self.host_environment.get("HOME").map(PathBuf::from);
            let denied = self
                .jobs
                .run(move || {
                    ledger_guard::guard(
                        &guard_command,
                        &guard_cwd,
                        &guard_root,
                        &guard_data,
                        guard_installation_root.as_deref(),
                        guard_home.as_deref(),
                    )
                })
                .await?;
            if let Some(denied) = denied {
                let rejected = serde_json::json!({
                    "ok":false,"command":command,"cwd":resolved_cwd.to_string_lossy(),
                    "exit_code":1,"timed_out":false,"stdout":"",
                    "stderr":denied["message"],"error":denied["error"],
                    "protected_path":denied["protected_path"],"next":denied["next"],
                    "evidence_receipts":evidence::receipts(false,&[]),
                    "evidence_capability_receipts":evidence::capability_receipts(Some(1),false,false,false,&[])
                });
                return JsonDocument::from_value(&rejected)
                    .map_err(|_| error("command_result_encoding_failed"));
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
                    BtccError::new("command_artifact_directory_failed", error.to_string())
                })?;
            let data = scope.butler_data.to_path_buf();
            let host = Arc::clone(&self.host_environment);
            let environment = self
                .jobs
                .run(move || NativeCommands::tool_environment(&host, &data))
                .await?
                .map_err(|e| BtccError::new(e.code, e.message))?;
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
                    #[cfg(test)]
                    test_late_reap: None,
                    #[cfg(test)]
                    test_pause_before_second_spawn: None,
                })
                .map_err(|e| BtccError::new(e.code, e.message))?
                .await
                .map_err(|_| error("command_completion_lost"))?;
            return output::registered_result(
                output::OutputResources {
                    output: &self.output,
                    jobs: &self.jobs,
                },
                command.into(),
                resolved_cwd.to_string_lossy().into_owned(),
                result,
                output::OutputOrigin {
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
        let before = Some(self.jobs.run(move || artifacts::snapshot(&data)).await?);
        let started = std::time::SystemTime::now();
        let input = GuidedCommandInput {
            command: command.to_owned(),
            cwd,
            workspace_root: root.clone(),
            butler_data: scope.butler_data.to_path_buf(),
            timeout_ms,
            access: GuidedAccess::ReadOnlyObservation,
            host_environment: (*self.host_environment).clone(),
            abort: scope.abort,
            #[cfg(test)]
            test_capture_fail_after_first_chunk: false,
            #[cfg(test)]
            test_late_reap: None,
        };
        let spooled = self
            .commands
            .submit_guided(input)
            .map_err(|e| BtccError::new(e.code, e.message))?
            .await
            .map_err(|_| error("command_completion_lost"))?
            .map_err(|e| BtccError::new(e.code, e.message))?;
        output::public_result(
            output::OutputResources {
                output: &self.output,
                jobs: &self.jobs,
            },
            spooled,
            output::OutputOrigin {
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

    pub(crate) async fn prepare_effect(
        &self,
        args: &Map<String, Value>,
        scope: CommandScope<'_>,
    ) -> Result<PreparedCommandEffect, BtccError> {
        effect::prepare(self, args, scope).await
    }
}

fn active_root(scope: &CommandScope<'_>) -> Result<PathBuf, BtccError> {
    match scope.workspace_reference {
        Some(reference) => reference
            .get()
            .map_err(|error| BtccError::new(error.code.clone(), error.code)),
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
    BtccError::new(code, code)
}
