use super::super::answer_join::join_cut;
use super::*;

/// Only a visible final candidate can reach synthesis and Work review.
pub(super) async fn settle_answer(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    reply: Reply,
    iteration: u32,
) -> Result<Step, AgentLoopError> {
    if let Some(step) = settle_progress(input, state, prepared, &reply).await? {
        return Ok(step);
    }
    if state.automatic_continuations == 0
        && state.phase == super::super::contracts::LoopPhase::Working
        && super::super::completion::bookkeeping_only(&state.tool_results)
    {
        return continue_answer(input, state, prepared,
            "Only progress/bookkeeping is recorded; the request may still be open. Check the original request against the results. Continue any unfinished work. If these records themselves satisfy the request, provide the substantive final answer now; otherwise progress is not completion."
        ).await;
    }
    let mut text = if state.answer_continuation {
        state.answer_continuation = false;
        std::mem::take(&mut state.cut_answer)
    } else {
        reply.text.clone()
    };
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

/// Nonfinal rounds and cuts continue before a visible final candidate is considered.
async fn settle_progress(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    reply: &Reply,
) -> Result<Option<Step>, AgentLoopError> {
    if reply.nonfinal {
        return continue_answer(input, state, prepared,
            "Your previous response only reported progress, not a final answer. Continue the request or provide its completed result."
        ).await.map(Some);
    }
    if (state.answer_continuation || reply.is_cut())
        && let Some(step) = advance_cut(input, state, prepared, reply).await?
    {
        return Ok(Some(step));
    }
    if reply.is_cut() {
        return continue_cut(input, state, reply).await.map(Some);
    }
    if reply.text.is_empty() && state.cut_answer.is_empty() {
        state.empty_recovery_used = true;
        return continue_answer(
            input,
            state,
            prepared,
            "Your previous response was empty. Continue and provide the required result.",
        )
        .await
        .map(Some);
    }
    Ok(None)
}

/// Only repeated cuts must extend the answer; a Complete round may just close it.
async fn advance_cut(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    reply: &Reply,
) -> Result<Option<Step>, AgentLoopError> {
    let joined = join_cut(&state.cut_answer, &reply.text);
    let added = joined
        .strip_prefix(&state.cut_answer)
        .unwrap_or_default()
        .trim();
    let no_progress = state.answer_continuation
        && reply.is_cut()
        && (added.is_empty() || state.cut_answer.contains(added))
        && !(reply.is_paused() && reply.provider_content_progress);
    state.answer_continuation = true;
    if !no_progress {
        state.cut_answer = joined;
    }
    if let Some(observer) = prepared.ports.stream_observer.as_deref() {
        observer.round_text_continued(&state.cut_answer);
    }
    let limit = crate::btcc::continuation_budget::model_context_byte_limit(
        input.semantic.model.context_window_tokens,
    );
    if no_progress || (reply.is_cut() && state.cut_answer.len() as u64 >= limit) {
        return finish_limit(
            input,
            state,
            if no_progress && reply.is_paused() {
                "provider_pause_not_resumed"
            } else if no_progress {
                "answer_not_extended"
            } else {
                "answer_context_limit"
            },
        )
        .await
        .map(|result| Some(Step::finished(result)));
    }
    Ok(None)
}

/// Pauses resume with the assistant last; token cuts ask for the remaining text.
async fn continue_cut(
    input: &Invocation<'_>,
    state: &mut State,
    reply: &Reply,
) -> Result<Step, AgentLoopError> {
    if reply.is_paused() {
        state.automatic_continuations = state.automatic_continuations.saturating_add(1);
        record_continuation(
            input,
            state,
            "turn.continuation.requested",
            "provider_paused",
        )
        .await;
        Ok(Step::Continue)
    } else {
        request_continuation(input, state,
            "Your previous response reached the output token limit and was cut off. Continue it from where it stopped: begin by repeating its last line exactly, then write the rest. Do not restart or summarize what you already wrote."
        ).await
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
    request_continuation(input, state, reason).await
}

async fn request_continuation(
    input: &Invocation<'_>,
    state: &mut State,
    reason: &str,
) -> Result<Step, AgentLoopError> {
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
    let code = if reason == "provider_pause_not_resumed" {
        "provider_pause_not_resumed"
    } else if state.cut_answer.is_empty() && !state.answer_continuation {
        "provider_context_limit_exceeded"
    } else {
        "provider_output_truncated"
    };
    let mut result = finish(input, state, Ending::Answer("")).await?;
    result.runtime_failure = Some(crate::btcc::RuntimeFailure::new(code, false));
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
