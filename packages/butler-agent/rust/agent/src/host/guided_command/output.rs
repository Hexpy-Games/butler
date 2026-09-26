use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use serde_json::{Map, Value};

use super::artifacts::{self, Snapshot};
use super::jobs::CommandJobs;
use super::{registered_artifacts, structured_stdout};
use crate::btcc::BtccError;
use crate::context::{
    BudgetToolOutputInput, NativeToolOutput, OutputModeInput, ShellCommandResult,
};
use crate::json::JsonDocument;
use crate::workspace::{
    GuidedCommandOutput, GuidedSummary, NativeCommands, StructuredCommandOutput,
};
use tokio_util::sync::CancellationToken;

mod assemble;

pub(super) struct OutputResources<'a> {
    pub output: &'a NativeToolOutput,
    pub jobs: &'a CommandJobs,
}

pub(super) struct OutputOrigin<'a> {
    pub args: &'a Map<String, Value>,
    pub workspace: &'a Path,
    pub data_root: &'a Path,
    pub started: SystemTime,
}

pub(super) struct RegisteredContext<'a> {
    pub before_git: Option<registered_artifacts::GitSnapshot>,
    pub commands: &'a NativeCommands,
    pub host_environment: Arc<HashMap<String, String>>,
    pub abort: CancellationToken,
}

struct StreamPayload<'a> {
    summary: GuidedSummary,
    stdout: String,
    stderr: String,
    before: Option<Snapshot>,
    effect: Option<&'a str>,
    registered_context: Option<RegisteredContext<'a>>,
}

struct SpoolCleanup(PathBuf);
impl Drop for SpoolCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(super) async fn public_result(
    resources: OutputResources<'_>,
    spooled: GuidedCommandOutput,
    origin: OutputOrigin<'_>,
    before: Option<Snapshot>,
    effect: Option<&str>,
) -> Result<JsonDocument, BtccError> {
    let cleanup = SpoolCleanup(spooled.payload_source.path.clone());
    let (bytes, _cleanup) = resources
        .jobs
        .run(move || {
            let bytes = std::fs::read(&cleanup.0);
            (bytes, cleanup)
        })
        .await?;
    let bytes = bytes.map_err(|_| error("command_output_unreadable"))?;
    let payload = &spooled.payload_source;
    let stdout = usize::try_from(payload.stdout_start)
        .ok()
        .zip(usize::try_from(payload.stdout_len).ok())
        .and_then(|(start, len)| start.checked_add(len).and_then(|end| bytes.get(start..end)))
        .map(String::from_utf8_lossy)
        .map(std::borrow::Cow::into_owned);
    let stderr = usize::try_from(payload.stderr_start)
        .ok()
        .zip(usize::try_from(payload.stderr_len).ok())
        .and_then(|(start, len)| start.checked_add(len).and_then(|end| bytes.get(start..end)))
        .map(String::from_utf8_lossy)
        .map(std::borrow::Cow::into_owned);
    let (stdout, stderr) = match (stdout, stderr) {
        (Some(stdout), Some(stderr)) => (stdout, stderr),
        _ => (String::new(), "Command output was not readable.".into()),
    };
    drop(bytes);
    from_streams(
        resources,
        origin,
        StreamPayload {
            summary: spooled.summary,
            stdout,
            stderr,
            before,
            effect,
            registered_context: None,
        },
    )
    .await
}

pub(super) async fn registered_result(
    resources: OutputResources<'_>,
    command: String,
    cwd: String,
    result: StructuredCommandOutput,
    origin: OutputOrigin<'_>,
    registered_context: RegisteredContext<'_>,
) -> Result<JsonDocument, BtccError> {
    if result.cancelled || registered_context.abort.is_cancelled() {
        return Err(error("command_cancelled"));
    }
    if let Some(error) = result.error {
        return Err(BtccError::new(error.code(), error.message()));
    }
    let summary = GuidedSummary {
        command,
        cwd,
        exit_code: result.exit_code,
        signal: None,
        timed_out: result.timed_out,
    };
    from_streams(
        resources,
        origin,
        StreamPayload {
            summary,
            stdout: result.stdout,
            stderr: result.stderr,
            before: None,
            effect: None,
            registered_context: Some(registered_context),
        },
    )
    .await
}

async fn from_streams(
    resources: OutputResources<'_>,
    origin: OutputOrigin<'_>,
    payload: StreamPayload<'_>,
) -> Result<JsonDocument, BtccError> {
    let OutputOrigin {
        args,
        workspace,
        data_root: butler_data,
        started,
    } = origin;
    let StreamPayload {
        summary,
        stdout,
        stderr,
        before,
        effect,
        registered_context,
    } = payload;
    let jobs = resources.jobs;
    let registered = registered_context.is_some();
    let registered_abort = registered_context.as_ref().map(|value| value.abort.clone());
    let (stdout, mut structured) = if registered {
        let (stdout, metadata) = jobs
            .run(move || {
                let metadata = structured_stdout::inspect(&stdout);
                (stdout, metadata)
            })
            .await?;
        (stdout, Some(metadata))
    } else {
        (stdout, None)
    };
    if let Some(metadata) = &mut structured {
        structured_stdout::append_declared_validation(
            metadata,
            args,
            summary.exit_code,
            summary.timed_out,
        );
    }
    let output_mode = if registered {
        let mode = args
            .get("output_mode")
            .and_then(Value::as_str)
            .filter(|mode| matches!(*mode, "auto" | "silent_on_success" | "full"))
            .unwrap_or("auto");
        OutputModeInput::Present(Value::String(mode.into()))
    } else {
        OutputModeInput::Present(
            args.get("output_mode")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(Value::String("auto".into())),
        )
    };
    let budget = resources
        .output
        .submit_budget(BudgetToolOutputInput {
            result: ShellCommandResult {
                stdout,
                stderr,
                exit_code: summary.exit_code,
                timed_out: summary.timed_out,
            },
            command: Some(summary.command.clone()),
            cwd: Some(summary.cwd.clone()),
            max_model_tokens: args.get("max_output_tokens").and_then(Value::as_f64),
            output_mode,
            validation_suite: args.get("validation_suite").cloned(),
            retain_original: registered,
        })
        .await
        .map_err(|error| BtccError::new(error.code, error.message))?
        .await
        .map_err(|_| error("tool_output_completion_lost"))?
        .map_err(|error| BtccError::new(error.code, error.message))?;
    let base = JsonDocument::from_encoded(
        budget
            .to_json_document()
            .map_err(|error| BtccError::new(error.code, error.message))?,
    )
    .map_err(|_| error("command_result_encoding_failed"))?;
    let success = budget.exit_code == Some(0) && !budget.timed_out;
    let cwd = PathBuf::from(&summary.cwd);
    let args_copy = args.clone();
    let workspace_owned = workspace.to_path_buf();
    let data = butler_data.to_path_buf();
    let (artifacts, requested, declared, publication_error) =
        if let Some(context) = registered_context {
            let stdout_paths = structured
                .as_mut()
                .map(|value| std::mem::take(&mut value.paths))
                .unwrap_or_default();
            let mut publication = jobs
                .run(move || {
                    registered_artifacts::publish(
                        &args_copy,
                        &stdout_paths,
                        &cwd,
                        &workspace_owned,
                        &data,
                        started,
                        success,
                    )
                })
                .await?;
            if publication.git_eligible
                && let Some(before) = context.before_git
                && let Some(after) = registered_artifacts::snapshot(
                    context.commands,
                    workspace,
                    context.host_environment,
                    context.abort,
                )
                .await
            {
                let workspace = workspace.to_path_buf();
                let data = butler_data.to_path_buf();
                publication = jobs
                    .run(move || {
                        registered_artifacts::append_git_delta(
                            &mut publication,
                            &before,
                            &after,
                            &workspace,
                            &data,
                        );
                        publication
                    })
                    .await?;
            }
            (
                publication.artifacts,
                publication.requested,
                publication.declared,
                None,
            )
        } else {
            let publication = jobs
                .run(move || {
                    artifacts::publish(
                        &args_copy,
                        &data,
                        &workspace_owned,
                        &cwd,
                        before.as_ref(),
                        success,
                    )
                })
                .await?;
            let count = publication.artifacts.len();
            (
                publication.artifacts,
                publication.requested,
                count,
                publication.error,
            )
        };
    if registered_abort.is_some_and(|abort| abort.is_cancelled()) {
        return Err(error("command_cancelled"));
    }
    assemble::assemble(assemble::Assembly {
        base: &base,
        budget: &budget,
        summary: &summary,
        artifacts: &artifacts,
        requested,
        declared,
        publication_error: publication_error.as_deref(),
        registered,
        effect,
        structured: structured.as_ref(),
    })
}

fn error(code: &'static str) -> BtccError {
    BtccError::new(code, code)
}
