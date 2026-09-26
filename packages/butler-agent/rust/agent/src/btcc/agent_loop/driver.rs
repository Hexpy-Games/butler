use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[cfg(test)]
use crate::btcc::StateExecutionClaim;
use crate::btcc::{
    AgentLoopError, AgentLoopProgress, AgentLoopResult, SuspensionReason, TurnRecord,
};

use super::completion::{after_batch, finish, finish_outcome, record_result};
use super::continuation::{
    AuthorityBatch, AuthorityLoopContinuation, pending_authority, unexecuted_call,
};
use super::contracts::{
    AgentLoopEvent, AuthorityDecision, BatchDisposition, CandidateDisposition, ModelRoundMessage,
    SemanticTurn,
};
use super::guided_ports::GuidedInvocation;
use super::model_round::run_model_round;
use super::ports::{AgentLoopObserver, GuidedPolicyPort, ModelRoundPort, propagated};
use super::progress::{Status, operation};
use super::state::{
    State, append_observations, assistant_message, begin_final_report, cancelled, emit,
    validate_decision,
};
use super::tool_batch;

pub(super) struct Invocation<'a> {
    pub turn: &'a TurnRecord,
    #[cfg(test)]
    pub claim: &'a StateExecutionClaim,
    pub recovery_attempt: u32,
    pub progress: &'a dyn AgentLoopProgress,
    pub model_round_observer: &'a dyn crate::btcc::ModelRoundObserver,
    pub semantic: SemanticTurn,
    pub cancellation: CancellationToken,
    pub model: &'a dyn ModelRoundPort,
    pub model_execution: &'a dyn crate::btcc::model_route::ModelExecution,
    pub policy: &'a dyn GuidedPolicyPort,
    pub operation_results: Option<&'a dyn super::operation_result_replay::OperationResultRuntime>,
    pub budget: Option<Arc<dyn crate::btcc::TurnContinuationBudgetPort>>,
    pub observer: Option<&'a dyn AgentLoopObserver>,
}

pub(super) async fn run(mut input: Invocation<'_>) -> Result<AgentLoopResult, AgentLoopError> {
    let mut prepared = input
        .policy
        .prepare(GuidedInvocation::from(&input))
        .await
        .map_err(propagated)?;
    let restored = input.semantic.authority.take();
    if restored.is_some() && prepared.authority_decision.is_none() {
        return Err(propagated(super::invalid_contract(
            "authority_decision_missing",
        )));
    }
    if let (Some(restored), Some(decision)) = (restored.as_ref(), &prepared.authority_decision) {
        validate_decision(restored, decision)?;
    }
    let mut state = if let Some(restored) = restored {
        drop(std::mem::take(&mut prepared.prompt));
        let used_tools = restored
            .tool_results
            .iter()
            .map(|result| result.name.clone())
            .collect();
        prepared.instructions = restored.instructions;
        prepared.stable_provider_cache_prefix = restored.stable_provider_cache_prefix;
        State {
            messages: restored.messages,
            tool_results: restored.tool_results,
            provider_continuation: restored.provider_continuation,
            next_item_ordinal: restored.next_item_ordinal,
            model_round_index: restored.model_round_index,
            iteration: restored.iteration,
            empty_recovery_used: restored.empty_response_recovery_used,
            final_report: false,
            resumed_batch: Some(restored.batch),
            resumed_call: prepared.resumed_tool_call.take(),
            presentation: restored.presentation,
            used_tools,
            runtime_failure: None,
        }
    } else {
        State {
            messages: {
                let mut prompt =
                    ModelRoundMessage::user(std::mem::take(&mut prepared.prompt), None);
                prompt.continuation_item_id = Some("turn-item-0".into());
                vec![prompt]
            },
            tool_results: Vec::new(),
            provider_continuation: None,
            next_item_ordinal: 1,
            model_round_index: 0,
            iteration: 0,
            empty_recovery_used: false,
            final_report: false,
            resumed_batch: None,
            resumed_call: prepared.resumed_tool_call.take(),
            presentation: None,
            used_tools: Vec::new(),
            runtime_failure: None,
        }
    };
    let context = input
        .policy
        .begin_context(GuidedInvocation::from(&input), input.budget.clone())
        .await
        .map_err(propagated)?;

    loop {
        cancelled(&input.cancellation)?;
        let iteration = state.iteration;
        state.iteration = state.iteration.saturating_add(1);
        let resumed_batch = state.resumed_batch.take();
        if resumed_batch.is_none() && state.resumed_call.is_none() {
            let observations = input
                .policy
                .before_model_round(GuidedInvocation::from(&input))
                .await
                .map_err(propagated)?;
            append_observations(&mut state, observations);
        }

        let (mut tools, mut surface_digest) = if let Some(batch) = &resumed_batch {
            (batch.tools.clone(), None)
        } else {
            input
                .policy
                .resolve_tools(
                    GuidedInvocation::from(&input),
                    &prepared.tools,
                    state.final_report,
                )
                .await
                .map_err(propagated)?
        };
        let (mut text, calls, text_call_names) = if let Some(batch) = &resumed_batch {
            (String::new(), batch.calls.clone(), Vec::new())
        } else if let Some(call) = state.resumed_call.take() {
            state
                .messages
                .push(assistant_message(String::new(), vec![call.clone()], None));
            (String::new(), vec![call], Vec::new())
        } else {
            let result = match run_model_round(
                &input,
                &mut state,
                &prepared,
                iteration,
                &mut tools,
                &mut surface_digest,
                context.as_ref(),
            )
            .await
            {
                Ok(result) => result,
                Err(AgentLoopError::Runtime(failure)) => {
                    state.runtime_failure = Some(failure);
                    return finish(&input, &state, "", None, None).await;
                }
                Err(error) => return Err(error),
            };
            let text = result.text.as_deref().unwrap_or_default().trim().to_owned();
            let calls = result.tool_calls;
            let mut text_call_names = result.text_tool_call_names;
            text_call_names.sort();
            text_call_names.dedup();
            if !text.is_empty() || !calls.is_empty() {
                state.messages.push(
                    result.assistant_message.unwrap_or_else(|| {
                        assistant_message(text.clone(), calls.clone(), result.raw)
                    }),
                );
            }
            (text, calls, text_call_names)
        };

        if !text_call_names.is_empty() {
            if calls.is_empty()
                && state.messages.last().is_some_and(|message| {
                    message.role == super::contracts::ModelRoundRole::Assistant
                })
            {
                state.messages.pop();
            }
            match input
                .policy
                .handle_text_tool_calls(
                    GuidedInvocation::from(&input),
                    &text_call_names,
                    &calls,
                    &text,
                    iteration,
                )
                .await
                .map_err(propagated)?
            {
                super::contracts::TextCallDisposition::Fail(error) => {
                    return Err(propagated(error));
                }
                #[cfg(test)]
                super::contracts::TextCallDisposition::Continue(observation) => {
                    if observation.trim().is_empty() {
                        return Err(propagated(super::invalid_contract(
                            "btcc_text_tool_call_observation_missing",
                        )));
                    }
                    state
                        .messages
                        .push(ModelRoundMessage::user(observation, None));
                    continue;
                }
            }
        }

        if calls.is_empty() {
            let candidate_accepted = !text.is_empty()
                && input
                    .policy
                    .accept_tool_candidate(GuidedInvocation::from(&input), &text)
                    .await
                    .map_err(propagated)?;
            let should_synthesize = !state.tool_results.is_empty()
                && ((!text.is_empty() && prepared.synthesize_after_tool_candidate)
                    || (text.is_empty() && prepared.synthesize_after_tool_empty))
                && !candidate_accepted;
            if should_synthesize {
                let synthesized = input
                    .policy
                    .synthesize_final(
                        GuidedInvocation::from(&input),
                        &state.messages,
                        state.iteration,
                    )
                    .await
                    .map_err(propagated)?;
                if !synthesized.trim().is_empty() {
                    text = synthesized;
                }
            }
            if text.is_empty() && !state.empty_recovery_used {
                state.empty_recovery_used = true;
                state.messages.push(ModelRoundMessage::user(
                    "Your previous response was empty. Continue and provide the required result."
                        .into(),
                    None,
                ));
                continue;
            }
            match input
                .policy
                .review_final_candidate(GuidedInvocation::from(&input), &text, iteration)
                .await
                .map_err(propagated)?
            {
                #[cfg(test)]
                CandidateDisposition::Wait => {
                    return finish(
                        &input,
                        &state,
                        "",
                        Some(SuspensionReason::WaitingForWorker),
                        None,
                    )
                    .await;
                }
                CandidateDisposition::Continue(observation) => {
                    if observation.trim().is_empty() {
                        return Err(propagated(super::invalid_contract(
                            "btcc_agent_loop_final_candidate_observation_missing",
                        )));
                    }
                    state.final_report = false;
                    state
                        .messages
                        .push(ModelRoundMessage::user(observation, None));
                    continue;
                }
                CandidateDisposition::Accepted(replacement) => {
                    let content = replacement
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or(text);
                    return finish(&input, &state, &content, None, None).await;
                }
            }
        }

        if resumed_batch.is_none()
            && let Some(budget) = &input.budget
        {
            budget
                .record_tool_round(&format!("btcc-tool-round-{iteration}"))
                .await
                .map_err(propagated)?;
        }
        let prepared_calls: Vec<_> = calls
            .iter()
            .map(|call| tool_batch::prepare(&tools, call))
            .collect();
        if resumed_batch.is_none() {
            input
                .policy
                .assistant_before_tools(GuidedInvocation::from(&input), &text, &calls, iteration)
                .await
                .map_err(propagated)?;
        }

        if tool_batch::concurrent(&prepared_calls, resumed_batch.is_some()) {
            for prepared_call in &prepared_calls {
                emit(
                    input.observer,
                    AgentLoopEvent::ToolCall {
                        iteration,
                        call: prepared_call.call.clone(),
                    },
                );
            }
            let results = tool_batch::execute_concurrent(
                input.policy,
                GuidedInvocation::from(&input),
                &prepared_calls,
            )
            .await
            .map_err(propagated)?;
            let mut first_outcome = None;
            for (prepared_call, result) in prepared_calls.iter().zip(&results) {
                state.used_tools.push(prepared_call.call.name.clone());
                let outcome = record_result(
                    &input,
                    &mut state,
                    &prepared_call.call,
                    result.clone(),
                    iteration,
                    first_outcome.is_none(),
                )
                .await?;
                if first_outcome.is_none() {
                    first_outcome = outcome;
                }
            }
            if let Some(result) = finish_outcome(&input, &state, first_outcome).await? {
                return Ok(result);
            }
            match after_batch(&input, &calls, &results, iteration).await? {
                BatchDisposition::Continue => {}
                BatchDisposition::FinalReport => begin_final_report(&mut state),
                BatchDisposition::Wait => {
                    return finish(
                        &input,
                        &state,
                        "",
                        Some(SuspensionReason::WaitingForWorker),
                        None,
                    )
                    .await;
                }
            }
            continue;
        }

        let mut batch_results = resumed_batch
            .as_ref()
            .map(|batch| batch.results.clone())
            .unwrap_or_default();
        let start = resumed_batch
            .as_ref()
            .map_or(0, |batch| batch.next_call_index);
        for (index, prepared_call) in prepared_calls.iter().enumerate().skip(start) {
            emit(
                input.observer,
                AgentLoopEvent::ToolCall {
                    iteration,
                    call: prepared_call.call.clone(),
                },
            );
            let result = match (&prepared.authority_decision, resumed_batch.is_some()) {
                (Some(AuthorityDecision::Deny | AuthorityDecision::Modify { .. }), true) => {
                    let result = unexecuted_call(
                        &prepared_call.call,
                        prepared.authority_decision.as_ref().unwrap(),
                        index == start,
                    );
                    input
                        .policy
                        .record_unexecuted(
                            GuidedInvocation::from(&input),
                            &prepared_call.call,
                            &result,
                        )
                        .await
                        .map_err(propagated)?;
                    operation(
                        input.progress,
                        &prepared_call.call.id,
                        &prepared_call.call.name,
                        Status::Cancelled,
                        None,
                    )
                    .await;
                    result
                }
                _ => {
                    tool_batch::execute(input.policy, GuidedInvocation::from(&input), prepared_call)
                        .await
                        .map_err(propagated)?
                }
            };
            state.used_tools.push(prepared_call.call.name.clone());
            if let Some(request_ref) = pending_authority(result.output.as_ref()) {
                let call_id = input
                    .policy
                    .operation_result_call_id(&prepared_call.call.id)
                    .ok_or_else(|| {
                        propagated(super::invalid_contract("authority_source_call_missing"))
                    })?;
                let presentation = input
                    .policy
                    .presentation(GuidedInvocation::from(&input))
                    .await
                    .map_err(propagated)?
                    .or_else(|| state.presentation.take());
                let continuation = AuthorityLoopContinuation {
                    request_ref,
                    call_id,
                    messages: std::mem::take(&mut state.messages),
                    next_item_ordinal: state.next_item_ordinal,
                    provider_continuation: state.provider_continuation.take(),
                    instructions: prepared.instructions.clone(),
                    stable_provider_cache_prefix: prepared.stable_provider_cache_prefix.clone(),
                    model_round_index: state.model_round_index,
                    iteration,
                    empty_response_recovery_used: state.empty_recovery_used,
                    tool_results: std::mem::take(&mut state.tool_results),
                    presentation,
                    batch: AuthorityBatch {
                        tools: tools.clone(),
                        calls: calls.clone(),
                        next_call_index: index,
                        results: batch_results,
                    },
                    extensions: Default::default(),
                };
                let value = serde_json::to_value(continuation).map_err(|_| {
                    propagated(super::invalid_contract("invalid_authority_continuation"))
                })?;
                return finish(
                    &input,
                    &state,
                    "",
                    Some(SuspensionReason::AuthorityPending),
                    Some(value),
                )
                .await;
            }
            batch_results.push(result.clone());
            let outcome = record_result(
                &input,
                &mut state,
                &prepared_call.call,
                result,
                iteration,
                true,
            )
            .await?;
            if let Some(result) = finish_outcome(&input, &state, outcome).await? {
                return Ok(result);
            }
        }
        if let Some(AuthorityDecision::Modify {
            input: modification,
        }) = &prepared.authority_decision
        {
            state.messages.push(ModelRoundMessage::user(
                modification.clone(),
                Some("current_user_request".into()),
            ));
        }
        match after_batch(&input, &calls, &batch_results, iteration).await? {
            BatchDisposition::Continue => {}
            BatchDisposition::FinalReport => begin_final_report(&mut state),
            BatchDisposition::Wait => {
                return finish(
                    &input,
                    &state,
                    "",
                    Some(SuspensionReason::WaitingForWorker),
                    None,
                )
                .await;
            }
        }
    }
}
