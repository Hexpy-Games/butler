//! What one handler's output adds to its turn's context.
use super::*;
use butler_runtime::context::{BudgetToolOutputInput, OutputModeInput, ShellCommandResult};
use serde_json::Value;

/// The most a single hook puts in the prompt; `ToolOutput` keeps the rest readable.
const MODEL_TOKENS: f64 = 8_000.0;

/// What `execute` carries into the run record and the dispatch result.
#[derive(Default)]
pub(super) struct Added {
    pub(super) context: Option<HookContext>,
    pub(super) bytes: Option<u64>,
    /// Told to the run log when the model got less than the whole output.
    pub(super) note: Option<String>,
}

/// A finished handler, as far as its turn's context is concerned.
pub(super) struct Finished<'a> {
    pub(super) outcome: &'a str,
    pub(super) exit_code: Option<i32>,
    /// Redacted stdout.
    pub(super) stdout: &'a str,
    /// Why a stream's read bound ended the process.
    pub(super) overflow: Option<String>,
}

/// Observe-only handlers finish after their turn has started, so they add nothing.
pub(super) fn can_add(hook: &HookDefinition) -> bool {
    hook.event.adds_context() && !hook.asynchronous
}

pub(super) async fn added(
    hooks: &Hooks,
    hook: &HookDefinition,
    payload: &HookEnvelope,
    finished: Finished<'_>,
) -> Added {
    // A synthetic test run has no session, so no conversation to add to.
    if !can_add(hook) || payload.session_id.is_none() {
        return Added::default();
    }
    // Past a read bound the whole output is gone with the process, so the model
    // hears that instead of nothing.
    if let Some(overflow) = finished.overflow {
        let text = format!("[Butler added none of this hook's output: {overflow}.]");
        return Added {
            context: Some(item(hook, text)),
            ..Added::default()
        };
    }
    if finished.exit_code != Some(0) || !matches!(finished.outcome, "continue" | "approval_ignored")
    {
        return Added::default();
    }
    let Some(text) = super::decision::added_context(finished.stdout) else {
        return Added::default();
    };
    let bytes = Some(text.len() as u64);
    let (text, note) = budgeted(hooks, hook, text).await;
    Added {
        context: Some(item(hook, text)),
        bytes,
        note,
    }
}

fn item(hook: &HookDefinition, text: String) -> HookContext {
    HookContext {
        hook: hook.label().to_owned(),
        event: hook.event,
        text,
    }
}

/// Text within the tool-output budget stays exact. Longer text becomes that
/// budget's preview and notice, with the original in its artifact. If the
/// budget itself fails, the model is told rather than given a silent gap.
async fn budgeted(hooks: &Hooks, hook: &HookDefinition, text: String) -> (String, Option<String>) {
    // Local estimators charge at most one token per UTF-8 byte.
    if text.len() as f64 <= MODEL_TOKENS {
        return (text, None);
    }
    let bytes = text.len();
    match budget(hooks, text).await {
        Ok((text, Some(artifact))) => (
            text,
            Some(format!(
                "{bytes} bytes of output: the model got a preview; the full text is in artifact {artifact}"
            )),
        ),
        Ok((text, None)) => (text, None),
        Err(error) => {
            tracing::warn!(event = "hook_context_budget_failed", hook_id = %hook.id, %error);
            (
                format!("[Butler could not add this hook's {bytes} bytes of output: {error}]"),
                Some(format!("{bytes} bytes of output not added: {error}")),
            )
        }
    }
}

async fn budget(hooks: &Hooks, text: String) -> Result<(String, Option<String>), String> {
    let budgeted = hooks
        .output
        .submit_budget(BudgetToolOutputInput {
            result: ShellCommandResult {
                stdout: text,
                stderr: String::new(),
                exit_code: Some(0),
                timed_out: false,
            },
            command: None,
            cwd: None,
            max_model_tokens: Some(MODEL_TOKENS),
            output_mode: OutputModeInput::Present(Value::String("auto".into())),
            validation_suite: None,
            retain_original: false,
        })
        .await
        .map_err(|error| error.to_string())?
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    let artifact = budgeted
        .butler_tool_artifact
        .as_ref()
        .map(|artifact| artifact.id.clone());
    Ok((budgeted.stdout_text(), artifact))
}
