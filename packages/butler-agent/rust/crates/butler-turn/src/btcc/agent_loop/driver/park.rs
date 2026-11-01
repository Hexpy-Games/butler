//! Suspending a turn on an authority request: a tool call's, or a project hook card's.

use super::*;

/// What a suspended execution resumes from, beyond the loop state itself.
pub(super) struct Parked {
    pub(super) request_ref: String,
    pub(super) call_id: String,
    pub(super) iteration: u32,
    pub(super) project_hooks_card: bool,
    pub(super) batch: AuthorityBatch,
}

/// Parks before the first model round: the hooks' answer decides what runs in this
/// turn, and resuming continues with the prompt the model has not seen yet.
pub(super) async fn for_project_hooks(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    card: &super::super::guided_ports::ProjectHooksCard,
) -> Result<AgentLoopResult, AgentLoopError> {
    let iteration = state.iteration;
    suspend(
        input,
        state,
        prepared,
        Parked {
            request_ref: card.request_ref.clone(),
            call_id: card.call_id.clone(),
            iteration,
            project_hooks_card: true,
            batch: AuthorityBatch::default(),
        },
    )
    .await
}

/// Persists the loop state as an authority continuation and suspends the turn.
pub(super) async fn suspend(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    parked: Parked,
) -> Result<AgentLoopResult, AgentLoopError> {
    let presentation = input
        .policy
        .presentation(GuidedInvocation::from(input))
        .await
        .map_err(propagated)?
        .or_else(|| state.presentation.take());
    // Rides on the continuation row the suspension writes anyway.
    let mut extensions = input.policy.continuation_extensions();
    for (key, value) in [
        ("browserPruneWatermark", state.browser_prune.watermark),
        ("browserPruneFloor", state.compacted_through),
    ] {
        if value > 0 {
            extensions.insert(key.into(), serde_json::json!(value));
        }
    }
    if let Some(diagnostics) = prepared
        .request
        .usage_attribution
        .as_ref()
        .and_then(|usage| usage.prompt_diagnostics.clone())
    {
        extensions.insert("promptDiagnostics".into(), diagnostics);
    }
    let continuation = AuthorityLoopContinuation {
        request_ref: parked.request_ref,
        call_id: parked.call_id,
        messages: std::mem::take(&mut state.messages),
        next_item_ordinal: state.next_item_ordinal,
        provider_continuation: state.provider_continuation.take(),
        instructions: prepared.instructions.clone(),
        stable_provider_cache_prefix: prepared.request.stable_provider_cache_prefix.clone(),
        model_round_index: state.model_round_index,
        iteration: parked.iteration,
        empty_response_recovery_used: state.empty_recovery_used,
        automatic_continuations: state.automatic_continuations,
        stop_hook_active: state.stop_hook_active,
        feedback_counts: std::mem::take(&mut state.feedback_counts),
        tool_results: std::mem::take(&mut state.tool_results),
        presentation,
        batch: parked.batch,
        project_hooks_card: parked.project_hooks_card,
        extensions,
    };
    finish(input, state, Ending::AwaitAuthority(Box::new(continuation))).await
}
