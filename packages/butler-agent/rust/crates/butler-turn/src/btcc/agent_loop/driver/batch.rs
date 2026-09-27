//! Tool batch execution of one loop iteration: concurrent or sequential calls, refusals, authority parking and the policy's settlement.

use super::*;

/// Runs the reply's tool calls, concurrently when all are safe, and applies
/// the policy's disposition for the settled batch.
pub(super) async fn run_tool_batch(
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
pub(super) struct ToolBatch<'a> {
    tools: &'a [ModelRoundTool],
    calls: &'a [ModelRoundToolCall],
    prepared_calls: &'a [PreparedCall<'a>],
    iteration: u32,
}

/// Where a sequential batch starts and what it already produced.
pub(super) struct BatchCursor {
    start: usize,
    results: Vec<ToolResult>,
    /// Set when the batch resumes after an authority decision.
    resumed: bool,
}

impl BatchCursor {
    pub(super) fn fresh() -> Self {
        Self {
            start: 0,
            results: Vec::new(),
            resumed: false,
        }
    }

    pub(super) fn resumed(batch: AuthorityBatch) -> Self {
        Self {
            start: batch.next_call_index,
            results: batch.results,
            resumed: true,
        }
    }
}

/// Charges the tool round to the turn budget and journals the assistant text
/// that precedes the calls. Resumed batches were announced before suspension.
pub(super) async fn announce_tool_round(
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

pub(super) async fn run_concurrent_batch(
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
pub(super) async fn run_sequential_batch(
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
            Some(super::super::state::CURRENT_USER_REQUEST.into()),
        ));
    }
    settle_batch(input, state, batch, &results).await
}

pub(super) fn emit_tool_call(
    input: &Invocation<'_>,
    prepared_call: &PreparedCall<'_>,
    iteration: u32,
) {
    emit(
        input.observer,
        &AgentLoopEvent::ToolCall {
            iteration,
            call: prepared_call.call.clone(),
        },
    );
}

/// Records a call the user's decision kept from running and reports it cancelled.
pub(super) async fn refuse_call(
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
pub(super) struct ParkedBatch<'a> {
    request_ref: String,
    call: &'a ModelRoundToolCall,
    next_call_index: usize,
    results: Vec<ToolResult>,
}

/// Persists the loop state as an authority continuation and suspends the turn.
pub(super) async fn suspend_for_authority(
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
            propagated(super::super::invalid_contract(
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
    finish(input, state, Ending::AwaitAuthority(Box::new(continuation))).await
}

/// Applies the policy's disposition for a settled batch.
pub(super) async fn settle_batch(
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
