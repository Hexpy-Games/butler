use tokio_util::sync::CancellationToken;

use super::super::contracts::*;
use super::super::storage;
use super::types::{self, CorrectionTargets, SourceWindow, add_usage};
use super::{Dependencies, coverage, parser, prompt};
use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire};
use crate::models::{ProviderPromptLifecycle, ProviderPromptRequest, ReasoningEffort};

pub(super) struct BatchInput<'a> {
    pub(super) windows: &'a [SourceWindow],
    pub(super) targets: &'a CorrectionTargets,
    pub(super) prompt: &'a str,
    pub(super) model: &'a str,
    pub(super) reasoning_effort: &'a str,
    pub(super) cache_scope: &'a str,
    pub(super) mode: ProfilingMode,
    pub(super) cancellation: &'a CancellationToken,
}

pub(super) async fn run_batch(
    dependencies: &Dependencies,
    input: BatchInput<'_>,
    usage: &mut ProfileModelUsageSummary,
    called: &mut bool,
) -> ProfileResult<(
    Vec<types::ExtractedCandidate>,
    Option<crate::models::PromptUsageReport>,
)> {
    let BatchInput {
        windows,
        targets,
        prompt,
        model,
        reasoning_effort,
        cache_scope,
        mode,
        cancellation,
    } = input;
    *called = true;
    let reasoning = reasoning(reasoning_effort);
    let instructions = prompt::instructions(mode);
    let attachments = [];
    let root = dependencies.root.to_string_lossy().into_owned();
    let request = ProviderPromptRequest {
        prompt,
        model: Some(model),
        reasoning_effort: Some(&reasoning),
        instructions: Some(&instructions),
        response_format: None,
        cache_scope: Some(cache_scope),
        cache_boundary: None,
        cancellation: cancellation.clone(),
        attachments: &attachments,
        butler_data: Some(&root),
        usage_attribution: None,
        stream_observer: None,
        provider_retry_attempts: None,
    };
    let response = dependencies
        .provider
        .run_prompt(request, ProviderPromptLifecycle::none())
        .await
        .map_err(|_| {
            ProfileError::new(
                "profile_model_failed",
                "Profile extractor model runner failed",
            )
        })?;
    add_usage(usage, model, response.usage.as_ref());
    let allowed = windows
        .iter()
        .map(|value| value.evidence_ref.clone())
        .collect();
    let extracted = parser::strict(&response.text, &allowed, mode, &targets.private)?;
    Ok((extracted, response.usage))
}

pub(super) async fn mark_batch_failed(
    dependencies: &Dependencies,
    windows: &[SourceWindow],
    nonce: &str,
    failure: &str,
    usage: &ProfileModelUsageSummary,
    cancellation: &CancellationToken,
) -> ProfileResult<()> {
    if blocking({
        let root = dependencies.root.clone();
        move || Ok(storage::read_consent(&root).mode)
    })
    .await?
        == ProfilingMode::Off
    {
        return Ok(());
    }
    let usage = serde_json::to_string(usage).map_err(|error| {
        ProfileError::new("profile_data_invalid", format!("usage summary: {error}"))
    })?;
    with_gate(dependencies, Some(cancellation.clone()), {
        let root = dependencies.root.clone();
        let host = dependencies.host.clone();
        let windows = windows.to_vec();
        let nonce = nonce.to_owned();
        let failure = failure.to_owned();
        move || coverage::mark_failed(&root, &windows, &failure, &usage, &nonce, host.as_ref())
    })
    .await
}

pub(super) async fn with_gate<T, F>(
    dependencies: &Dependencies,
    cancellation: Option<CancellationToken>,
    operation: F,
) -> ProfileResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> ProfileResult<T> + Send + 'static,
{
    let mut request = CognitionWriteAcquire::immediate(dependencies.lock.clone(), "projection");
    request.cancellation = cancellation;
    let lease = dependencies
        .coordinator
        .acquire(request, CognitionWaitClass::Background)
        .await
        .map_err(|_| {
            ProfileError::new("profile_store_unavailable", "Profile store is unavailable.")
        })?
        .ok_or_else(|| ProfileError::new("memory_write_busy", "Memory writer is busy."))?;
    blocking(move || {
        let result = operation();
        let released = lease.release(result.is_ok()).map_err(|_| {
            ProfileError::new("profile_store_unavailable", "Profile store is unavailable.")
        });
        match (result, released) {
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
            (Ok(value), Ok(())) => Ok(value),
        }
    })
    .await
}

pub(super) async fn blocking<T, F>(operation: F) -> ProfileResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> ProfileResult<T> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|_| ProfileError::new("profile_operation_failed", "Profile operation failed."))?
}
pub(super) fn reasoning(value: &str) -> ReasoningEffort {
    match value {
        "none" => ReasoningEffort::None,
        "low" => ReasoningEffort::Low,
        "medium" => ReasoningEffort::Medium,
        "high" => ReasoningEffort::High,
        "max" => ReasoningEffort::Max,
        _ => ReasoningEffort::Xhigh,
    }
}
