//! The agent loop: model rounds and tool batches until the turn answers or suspends.
//!
//! One iteration opens (cancellation, steering), obtains the assistant reply
//! (a model round, or a replayed batch/call on resume), and then either
//! settles a final answer or runs the requested tool batch.

use crate::btcc::BtccCode;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[cfg(any(test, feature = "test-support"))]
use crate::btcc::StateExecutionClaim;
use crate::btcc::{
    AgentLoopError, AgentLoopProgress, AgentLoopResult, SuspensionReason, TurnRecord,
};

use super::completion::{Ending, OutcomeCheck, after_batch, finish, finish_outcome, record_result};
use super::continuation::{
    AuthorityBatch, AuthorityLoopContinuation, Refusal, RefusedCall, pending_authority,
    unexecuted_call,
};
use super::contracts::{
    AgentLoopEvent, AuthorityDecision, BatchDisposition, CandidateDisposition, ModelRoundMessage,
    ModelRoundRole, ModelRoundTool, ModelRoundToolCall, PreparedPolicy, SemanticTurn,
    TextCallDisposition, ToolResult, ToolSurface,
};
use super::guided_ports::{GuidedInvocation, TurnContextProjection};
use super::model_round::run_model_round;
use super::ports::{AgentLoopObserver, GuidedPolicyPort, ModelRoundPort, propagated};
use super::progress::{Status, operation};
use super::state::{
    State, append_observations, assistant_message, begin_final_report, cancelled, emit,
    validate_decision,
};
use super::tool_batch::{self, PreparedCall};

/// Everything one loop execution borrows from the turn runtime.
pub(super) struct Invocation<'a> {
    pub turn: &'a TurnRecord,
    #[cfg(any(test, feature = "test-support"))]
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

/// Whether the loop runs another iteration or has its result.
enum Step {
    Continue,
    Finished(Box<AgentLoopResult>),
}

impl Step {
    fn finished(result: AgentLoopResult) -> Self {
        Self::Finished(Box::new(result))
    }
}

/// The assistant's reply for one iteration.
struct Reply {
    text: String,
    calls: Vec<ModelRoundToolCall>,
    /// Tool names the model wrote as text, sorted and deduplicated.
    text_call_names: Vec<String>,
}

/// Runs the model/tool loop for one admitted turn until it answers or suspends.
pub(super) async fn run(mut input: Invocation<'_>) -> Result<AgentLoopResult, AgentLoopError> {
    let mut prepared = input
        .policy
        .prepare(GuidedInvocation::from(&input))
        .await
        .map_err(propagated)?;
    let mut state = restore_state(&mut input, &mut prepared)?;
    let context = input
        .policy
        .begin_context(GuidedInvocation::from(&input), input.budget.clone())
        .await
        .map_err(propagated)?;
    loop {
        match run_iteration(&input, &mut state, &prepared, context.as_ref()).await? {
            Step::Continue => {}
            Step::Finished(result) => return Ok(*result),
        }
    }
}

/// Builds the loop state, resuming from the turn's authority continuation when
/// it has one. A resumed turn must carry a valid decision for its pending call.
fn restore_state(
    input: &mut Invocation<'_>,
    prepared: &mut PreparedPolicy,
) -> Result<State, AgentLoopError> {
    let Some(restored) = input.semantic.authority.take() else {
        return Ok(State::fresh(prepared));
    };
    let Some(decision) = &prepared.authority_decision else {
        return Err(propagated(super::invalid_contract(
            BtccCode::AuthorityDecisionMissing,
        )));
    };
    validate_decision(&restored, decision)?;
    Ok(State::resumed(restored, prepared))
}

async fn run_iteration(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    context: &dyn TurnContextProjection,
) -> Result<Step, AgentLoopError> {
    cancelled(&input.cancellation)?;
    let iteration = state.begin_iteration();
    let resumed_batch = state.resumed_batch.take();
    if !state.is_replaying(resumed_batch.as_ref()) {
        observe_steering(input, state).await?;
    }
    let mut surface = match &resumed_batch {
        Some(batch) => ToolSurface {
            tools: batch.tools.clone(),
            digest: None,
        },
        None => input
            .policy
            .resolve_tools(GuidedInvocation::from(input), &prepared.tools, state.phase)
            .await
            .map_err(propagated)?,
    };
    let reply = match &resumed_batch {
        Some(batch) => Reply {
            text: String::new(),
            calls: batch.calls.clone(),
            text_call_names: Vec::new(),
        },
        None => {
            match obtain_reply(input, state, prepared, iteration, &mut surface, context).await {
                Ok(reply) => reply,
                Err(AgentLoopError::Runtime(failure)) => {
                    state.runtime_failure = Some(failure);
                    return finish(input, state, Ending::Answer(""))
                        .await
                        .map(Step::finished);
                }
                Err(error) => return Err(error),
            }
        }
    };
    reject_text_tool_calls(input, state, &reply, iteration).await?;
    if reply.calls.is_empty() {
        return settle_answer(input, state, prepared, reply.text, iteration).await;
    }
    run_tool_batch(
        input,
        state,
        prepared,
        &surface.tools,
        &reply,
        iteration,
        resumed_batch,
    )
    .await
}

async fn observe_steering(input: &Invocation<'_>, state: &mut State) -> Result<(), AgentLoopError> {
    let observations = input
        .policy
        .before_model_round(GuidedInvocation::from(input))
        .await
        .map_err(propagated)?;
    append_observations(state, observations);
    Ok(())
}

/// The assistant reply of a fresh iteration: the accepted call replayed on
/// resume, or a new model round appended to the transcript.
async fn obtain_reply(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    iteration: u32,
    surface: &mut ToolSurface,
    context: &dyn TurnContextProjection,
) -> Result<Reply, AgentLoopError> {
    if let Some(call) = state.resumed_call.take() {
        state
            .messages
            .push(assistant_message(String::new(), vec![call.clone()], None));
        return Ok(Reply {
            text: String::new(),
            calls: vec![call],
            text_call_names: Vec::new(),
        });
    }
    let result = run_model_round(input, state, prepared, iteration, surface, context).await?;
    let text = result.text.as_deref().unwrap_or_default().trim().to_owned();
    let calls = result.tool_calls;
    let mut text_call_names = result.text_tool_call_names;
    text_call_names.sort();
    text_call_names.dedup();
    if !text.is_empty() || !calls.is_empty() {
        let message = result
            .assistant_message
            .unwrap_or_else(|| assistant_message(text.clone(), calls.clone(), result.raw));
        state.messages.push(message);
    }
    Ok(Reply {
        text,
        calls,
        text_call_names,
    })
}

/// Tool calls written as text are a contract failure; the journal records
/// them and decides the error. A text-only assistant message is dropped first.
async fn reject_text_tool_calls(
    input: &Invocation<'_>,
    state: &mut State,
    reply: &Reply,
    iteration: u32,
) -> Result<(), AgentLoopError> {
    if reply.text_call_names.is_empty() {
        return Ok(());
    }
    let last_is_assistant = state
        .messages
        .last()
        .is_some_and(|message| message.role == ModelRoundRole::Assistant);
    if reply.calls.is_empty() && last_is_assistant {
        state.messages.pop();
    }
    let disposition = input
        .policy
        .handle_text_tool_calls(
            GuidedInvocation::from(input),
            &reply.text_call_names,
            &reply.calls,
            &reply.text,
            iteration,
        )
        .await
        .map_err(propagated)?;
    match disposition {
        TextCallDisposition::Fail(error) => Err(propagated(error)),
    }
}

/// Handles a reply without tool calls: synthesis, one empty-reply recovery,
/// then the Work review that accepts the answer or sends the model back.
async fn settle_answer(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    mut text: String,
    iteration: u32,
) -> Result<Step, AgentLoopError> {
    if let Some(synthesized) = synthesize_answer(input, state, prepared, &text).await? {
        text = synthesized;
    }
    if text.is_empty() && !state.empty_recovery_used {
        state.empty_recovery_used = true;
        state.messages.push(ModelRoundMessage::user(
            "Your previous response was empty. Continue and provide the required result.".into(),
            None,
        ));
        return Ok(Step::Continue);
    }
    let review = input
        .policy
        .review_final_candidate(GuidedInvocation::from(input), &text, iteration)
        .await
        .map_err(propagated)?;
    match review {
        CandidateDisposition::Continue(observation) => {
            if observation.trim().is_empty() {
                return Err(propagated(super::invalid_contract(
                    BtccCode::BtccAgentLoopFinalCandidateObservationMissing,
                )));
            }
            state.phase = super::contracts::LoopPhase::Working;
            state
                .messages
                .push(ModelRoundMessage::user(observation, None));
            Ok(Step::Continue)
        }
        CandidateDisposition::Accepted(replacement) => {
            let content = replacement
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(text);
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

/// Runs the reply's tool calls, concurrently when all are safe, and applies
/// the policy's disposition for the settled batch.
async fn run_tool_batch(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    tools: &[ModelRoundTool],
    reply: &Reply,
    iteration: u32,
    resumed_batch: Option<AuthorityBatch>,
) -> Result<Step, AgentLoopError> {
    let prepared_calls: Vec<_> = reply
        .calls
        .iter()
        .map(|call| tool_batch::prepare(tools, call))
        .collect();
    let batch = ToolBatch {
        tools,
        calls: &reply.calls,
        prepared_calls: &prepared_calls,
        iteration,
    };
    let Some(resumed) = resumed_batch else {
        announce_tool_round(input, &reply.text, &reply.calls, iteration).await?;
        return if tool_batch::concurrent(&prepared_calls) {
            run_concurrent_batch(input, state, &batch).await
        } else {
            run_sequential_batch(input, state, prepared, &batch, BatchCursor::fresh()).await
        };
    };
    run_sequential_batch(
        input,
        state,
        prepared,
        &batch,
        BatchCursor::resumed(resumed),
    )
    .await
}

/// One tool batch of an iteration.
struct ToolBatch<'a> {
    tools: &'a [ModelRoundTool],
    calls: &'a [ModelRoundToolCall],
    prepared_calls: &'a [PreparedCall<'a>],
    iteration: u32,
}

/// Where a sequential batch starts and what it already produced.
struct BatchCursor {
    start: usize,
    results: Vec<ToolResult>,
    /// Set when the batch resumes after an authority decision.
    resumed: bool,
}

impl BatchCursor {
    fn fresh() -> Self {
        Self {
            start: 0,
            results: Vec::new(),
            resumed: false,
        }
    }

    fn resumed(batch: AuthorityBatch) -> Self {
        Self {
            start: batch.next_call_index,
            results: batch.results,
            resumed: true,
        }
    }
}

/// Charges the tool round to the turn budget and journals the assistant text
/// that precedes the calls. Resumed batches were announced before suspension.
async fn announce_tool_round(
    input: &Invocation<'_>,
    text: &str,
    calls: &[ModelRoundToolCall],
    iteration: u32,
) -> Result<(), AgentLoopError> {
    if let Some(budget) = &input.budget {
        budget
            .record_tool_round(&format!("btcc-tool-round-{iteration}"))
            .await
            .map_err(propagated)?;
    }
    input
        .policy
        .assistant_before_tools(GuidedInvocation::from(input), text, calls, iteration)
        .await
        .map_err(propagated)
}

async fn run_concurrent_batch(
    input: &Invocation<'_>,
    state: &mut State,
    batch: &ToolBatch<'_>,
) -> Result<Step, AgentLoopError> {
    for prepared_call in batch.prepared_calls {
        emit_tool_call(input, prepared_call, batch.iteration);
    }
    let results = tool_batch::execute_concurrent(
        input.policy,
        GuidedInvocation::from(input),
        batch.prepared_calls,
    )
    .await
    .map_err(propagated)?;
    let mut first_outcome = None;
    for (prepared_call, result) in batch.prepared_calls.iter().zip(&results) {
        state.used_tools.push(prepared_call.call.name.clone());
        let check = if first_outcome.is_none() {
            OutcomeCheck::Evaluate
        } else {
            OutcomeCheck::RecordOnly
        };
        let outcome = record_result(
            input,
            state,
            &prepared_call.call,
            result.clone(),
            batch.iteration,
            check,
        )
        .await?;
        if first_outcome.is_none() {
            first_outcome = outcome;
        }
    }
    if let Some(result) = finish_outcome(input, state, first_outcome).await? {
        return Ok(Step::finished(result));
    }
    settle_batch(input, state, batch, &results).await
}

/// Runs calls one by one from the cursor. A call parked on an authority request
/// suspends the turn with the batch persisted; on resume a refusal marks the
/// pending and later calls unexecuted.
async fn run_sequential_batch(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    batch: &ToolBatch<'_>,
    cursor: BatchCursor,
) -> Result<Step, AgentLoopError> {
    let BatchCursor {
        start,
        mut results,
        resumed,
    } = cursor;
    let refusal = if resumed {
        Refusal::from_decision(prepared.authority_decision.as_ref())
    } else {
        None
    };
    for (index, prepared_call) in batch.prepared_calls.iter().enumerate().skip(start) {
        emit_tool_call(input, prepared_call, batch.iteration);
        let position = if index == start {
            RefusedCall::Pending
        } else {
            RefusedCall::Following
        };
        let result = match refusal {
            Some(refusal) => refuse_call(input, &prepared_call.call, refusal, position).await?,
            None => tool_batch::execute(input.policy, GuidedInvocation::from(input), prepared_call)
                .await
                .map_err(propagated)?,
        };
        state.used_tools.push(prepared_call.call.name.clone());
        if let Some(request_ref) = pending_authority(result.output.as_ref()) {
            let parked = ParkedBatch {
                request_ref,
                call: &prepared_call.call,
                next_call_index: index,
                results,
            };
            return suspend_for_authority(input, state, prepared, batch, parked)
                .await
                .map(Step::finished);
        }
        results.push(result.clone());
        let outcome = record_result(
            input,
            state,
            &prepared_call.call,
            result,
            batch.iteration,
            OutcomeCheck::Evaluate,
        )
        .await?;
        if let Some(result) = finish_outcome(input, state, outcome).await? {
            return Ok(Step::finished(result));
        }
    }
    if let Some(AuthorityDecision::Modify {
        input: modification,
    }) = &prepared.authority_decision
    {
        state.messages.push(ModelRoundMessage::user(
            modification.clone(),
            Some(super::state::CURRENT_USER_REQUEST.into()),
        ));
    }
    settle_batch(input, state, batch, &results).await
}

fn emit_tool_call(input: &Invocation<'_>, prepared_call: &PreparedCall<'_>, iteration: u32) {
    emit(
        input.observer,
        &AgentLoopEvent::ToolCall {
            iteration,
            call: prepared_call.call.clone(),
        },
    );
}

/// Records a call the user's decision kept from running and reports it cancelled.
async fn refuse_call(
    input: &Invocation<'_>,
    call: &ModelRoundToolCall,
    refusal: Refusal,
    position: RefusedCall,
) -> Result<ToolResult, AgentLoopError> {
    let result = unexecuted_call(call, refusal, position);
    input
        .policy
        .record_unexecuted(GuidedInvocation::from(input), call, &result)
        .await
        .map_err(propagated)?;
    operation(
        input.progress,
        &call.id,
        &call.name,
        Status::Cancelled,
        None,
    )
    .await;
    Ok(result)
}

/// A sequential batch stopped at a call that waits for an authority decision.
struct ParkedBatch<'a> {
    request_ref: String,
    call: &'a ModelRoundToolCall,
    next_call_index: usize,
    results: Vec<ToolResult>,
}

/// Persists the loop state as an authority continuation and suspends the turn.
async fn suspend_for_authority(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    batch: &ToolBatch<'_>,
    parked: ParkedBatch<'_>,
) -> Result<AgentLoopResult, AgentLoopError> {
    let call_id = input
        .policy
        .operation_result_call_id(&parked.call.id)
        .ok_or_else(|| {
            propagated(super::invalid_contract(
                BtccCode::AuthoritySourceCallMissing,
            ))
        })?;
    let presentation = input
        .policy
        .presentation(GuidedInvocation::from(input))
        .await
        .map_err(propagated)?
        .or_else(|| state.presentation.take());
    let continuation = AuthorityLoopContinuation {
        request_ref: parked.request_ref,
        call_id,
        messages: std::mem::take(&mut state.messages),
        next_item_ordinal: state.next_item_ordinal,
        provider_continuation: state.provider_continuation.take(),
        instructions: prepared.instructions.clone(),
        stable_provider_cache_prefix: prepared.request.stable_provider_cache_prefix.clone(),
        model_round_index: state.model_round_index,
        iteration: batch.iteration,
        empty_response_recovery_used: state.empty_recovery_used,
        tool_results: std::mem::take(&mut state.tool_results),
        presentation,
        batch: AuthorityBatch {
            tools: batch.tools.to_vec(),
            calls: batch.calls.to_vec(),
            next_call_index: parked.next_call_index,
            results: parked.results,
        },
        extensions: Default::default(),
    };
    let value = serde_json::to_value(continuation).map_err(|source| {
        propagated(
            super::invalid_contract(BtccCode::InvalidAuthorityContinuation).with_source(source),
        )
    })?;
    finish(input, state, Ending::AwaitAuthority(value)).await
}

/// Applies the policy's disposition for a settled batch.
async fn settle_batch(
    input: &Invocation<'_>,
    state: &mut State,
    batch: &ToolBatch<'_>,
    results: &[ToolResult],
) -> Result<Step, AgentLoopError> {
    match after_batch(input, batch.calls, results, batch.iteration).await? {
        BatchDisposition::Continue => Ok(Step::Continue),
        BatchDisposition::FinalReport => {
            begin_final_report(state);
            Ok(Step::Continue)
        }
        BatchDisposition::Wait => finish(
            input,
            state,
            Ending::Suspend(SuspensionReason::WaitingForWorker),
        )
        .await
        .map(Step::finished),
    }
}
