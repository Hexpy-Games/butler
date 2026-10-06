use super::*;

/// Only a visible final candidate can reach synthesis and Work review.
pub(super) async fn settle_answer(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    reply: Reply,
    iteration: u32,
) -> Result<Step, AgentLoopError> {
    if reply.text.is_empty() || reply.nonfinal {
        let reason = if reply.nonfinal {
            "Your previous response only reported progress, not a final answer. Continue the request or provide its completed result."
        } else {
            state.empty_recovery_used = true;
            "Your previous response was empty. Continue and provide the required result."
        };
        return continue_answer(input, state, prepared, reason).await;
    }
    if state.automatic_continuations == 0
        && state.phase == super::super::contracts::LoopPhase::Working
        && super::super::completion::bookkeeping_only(&state.tool_results)
    {
        return continue_answer(input, state, prepared,
            "Only progress/bookkeeping is recorded; the request may still be open. Check the original request against the results. Continue any unfinished work. If these records themselves satisfy the request, provide the substantive final answer now; otherwise progress is not completion."
        ).await;
    }
    let mut text = reply.text;
    if let Some(synthesized) = synthesize_answer(input, state, prepared, &text).await? {
        reject_round_text(prepared);
        text = synthesized;
    }
    let review = input
        .policy
        .review_final_candidate(GuidedInvocation::from(input), &text, iteration)
        .await
        .map_err(propagated)?;
    match review {
        CandidateDisposition::Continue(observation) => {
            if observation.trim().is_empty() {
                return Err(propagated(super::super::invalid_contract(
                    BtccCode::BtccAgentLoopFinalCandidateObservationMissing,
                )));
            }
            continue_answer(input, state, prepared, &observation).await
        }
        CandidateDisposition::Accepted(replacement) => {
            let content = replacement
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(text);
            if let Some(reason) = super::super::hooks::stop(
                input.policy,
                GuidedInvocation::from(input),
                &content,
                state.stop_hook_active,
                iteration,
            )
            .await
            {
                state.stop_hook_active = true;
                return continue_answer(input, state, prepared, &reason).await;
            }
            finish(input, state, Ending::Answer(&content))
                .await
                .map(Step::finished)
        }
    }
}

/// The journal's synthesized answer, when the policy asks for one after tool
/// use and the journal did not accept the model's own candidate.
async fn synthesize_answer(
    input: &Invocation<'_>,
    state: &State,
    prepared: &PreparedPolicy,
    text: &str,
) -> Result<Option<String>, AgentLoopError> {
    let candidate_accepted = !text.is_empty()
        && input
            .policy
            .accept_tool_candidate(GuidedInvocation::from(input), text)
            .await
            .map_err(propagated)?;
    let synthesize = !state.tool_results.is_empty()
        && prepared.final_synthesis.applies_to(text)
        && !candidate_accepted;
    if !synthesize {
        return Ok(None);
    }
    let synthesized = input
        .policy
        .synthesize_final(
            GuidedInvocation::from(input),
            &state.messages,
            state.iteration,
        )
        .await
        .map_err(propagated)?;
    Ok((!synthesized.trim().is_empty()).then_some(synthesized))
}

/// Corrections are observations, never authority to stop the actor.
pub(super) async fn continue_answer(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    reason: &str,
) -> Result<Step, AgentLoopError> {
    reject_round_text(prepared);
    state.automatic_continuations = state.automatic_continuations.saturating_add(1);
    // A report correction cannot reopen settled execution. Explicit user
    // steering reopens it through append_observations instead.
    record_continuation(input, state, "turn.continuation.requested", reason).await;
    let observation = state.feedback(reason);
    state.messages.push(ModelRoundMessage::user(
        observation,
        Some("automatic_continuation".into()),
    ));
    Ok(Step::Continue)
}

/// Limits produce a truthful visible status, even when no model answer was accepted.
pub(super) async fn finish_limit(
    input: &Invocation<'_>,
    state: &State,
    reason: &str,
) -> Result<AgentLoopResult, AgentLoopError> {
    record_continuation(input, state, "turn.continuation.limit_reached", reason).await;
    let content = "The required input cannot fit the model context. Reduce the required attachments or split the request into smaller parts so I can continue.";
    let mut result = finish(input, state, Ending::Answer(content)).await?;
    result.terminal_outcome = Some(crate::btcc::TerminalOutcome::Failed);
    Ok(result)
}

async fn record_continuation(input: &Invocation<'_>, state: &State, kind: &str, reason: &str) {
    let mut event = crate::btcc::RuntimeTurnEventInput::new(kind);
    event.payload = serde_json::json!({
        "reason": reason, "automaticContinuations": state.automatic_continuations,
        "iteration": state.iteration, "toolResultCount": state.tool_results.len(),
    })
    .as_object()
    .cloned();
    let _ = input.progress.emit(event).await;
}

fn reject_round_text(prepared: &PreparedPolicy) {
    if let Some(observer) = prepared.ports.stream_observer.as_deref() {
        observer.round_text_rejected();
    }
}
