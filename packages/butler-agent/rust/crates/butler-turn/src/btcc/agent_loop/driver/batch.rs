//! Tool batch execution of one loop iteration: concurrent or sequential calls, refusals, authority parking and the policy's settlement.

use super::*;

mod concurrent;
use super::super::tool_batch::ExecutedCall;
use concurrent::run_concurrent_batch;

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
            run_concurrent_batch(input, state, prepared, &batch).await
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
    concurrent_results: Vec<ExecutedCall>,
    concurrent_call_ids: Vec<String>,
    pending_modifications: Vec<String>,
    first_suspension: Option<SuspensionReason>,
}

impl BatchCursor {
    pub(super) fn fresh() -> Self {
        Self {
            start: 0,
            results: Vec::new(),
            resumed: false,
            concurrent_results: Vec::new(),
            concurrent_call_ids: Vec::new(),
            pending_modifications: Vec::new(),
            first_suspension: None,
        }
    }

    pub(super) fn resumed(batch: AuthorityBatch) -> Self {
        Self {
            start: batch.next_call_index,
            results: batch.results,
            resumed: true,
            concurrent_results: batch
                .concurrent_results
                .into_iter()
                .map(ExecutedCall::restored)
                .collect(),
            concurrent_call_ids: batch.concurrent_call_ids,
            pending_modifications: batch.pending_modifications,
            first_suspension: batch.first_suspension,
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
        concurrent_results,
        concurrent_call_ids,
        mut pending_modifications,
        mut first_suspension,
    } = cursor;
    let refusal = Refusal::from_decision(prepared.authority_decision.as_ref()).filter(|_| resumed);
    if resumed {
        collect_modification(&mut pending_modifications, prepared);
    }
    for (index, prepared_call) in batch.prepared_calls.iter().enumerate().skip(start) {
        if concurrent_results.is_empty() || (resumed && index == start) {
            emit_tool_call(input, prepared_call, batch.iteration);
        }
        let position = if index == start {
            RefusedCall::Pending
        } else {
            RefusedCall::Following
        };
        let result = batch_result(
            input,
            prepared_call,
            refusal,
            position,
            index,
            resumed.then_some(start),
            &concurrent_results,
        )
        .await?;
        state.used_tools.push(prepared_call.call.name.clone());
        if let Some(request_ref) = result.pending_authority {
            let parked = ParkedBatch {
                request_ref,
                call: &prepared_call.call,
                next_call_index: index,
                results,
                call_id: concurrent_call_ids.get(index).cloned(),
                concurrent_results,
                concurrent_call_ids,
                pending_modifications,
                first_suspension,
            };
            return park_batch(input, state, prepared, batch, parked).await;
        }
        let result = result.result;
        results.push(result.clone());
        record_batch_result(
            input,
            state,
            prepared_call,
            result,
            batch.iteration,
            &mut first_suspension,
            concurrent_call_ids.get(index).map(String::as_str),
        )
        .await?;
        if concurrent_results.is_empty() && first_suspension.is_some() {
            break;
        }
    }
    append_modifications(state, pending_modifications);
    let outcome = first_suspension.map(super::super::contracts::ToolOutcome::Suspend);
    if let Some(result) = finish_outcome(input, state, outcome).await? {
        return Ok(Step::finished(result));
    }
    settle_batch(input, state, batch, &results).await
}

/// Evaluate until the first effective outcome while recording every settled sibling.
async fn record_batch_result(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedCall<'_>,
    result: ToolResult,
    iteration: u32,
    first_suspension: &mut Option<SuspensionReason>,
    restored_call_id: Option<&str>,
) -> Result<(), AgentLoopError> {
    let check = if first_suspension.is_none() {
        OutcomeCheck::Evaluate
    } else {
        OutcomeCheck::RecordOnly
    };
    if let Some(super::super::contracts::ToolOutcome::Suspend(reason)) = record_result(
        input,
        state,
        &prepared.call,
        result,
        iteration,
        check,
        restored_call_id,
    )
    .await?
    {
        *first_suspension = Some(reason);
    }
    Ok(())
}

fn collect_modification(pending: &mut Vec<String>, prepared: &PreparedPolicy) {
    if let Some(AuthorityDecision::Modify {
        input: modification,
    }) = &prepared.authority_decision
    {
        pending.push(modification.clone());
    }
}

fn append_modifications(state: &mut State, pending: Vec<String>) {
    for modification in pending {
        state.messages.push(ModelRoundMessage::user(
            modification,
            Some(super::super::state::CURRENT_USER_REQUEST.into()),
        ));
    }
}

/// Reuse settled siblings; park later pending siblings before executing them.
async fn batch_result(
    input: &Invocation<'_>,
    prepared: &PreparedCall<'_>,
    refusal: Option<Refusal>,
    position: RefusedCall,
    index: usize,
    resumed_start: Option<usize>,
    concurrent: &[ExecutedCall],
) -> Result<ExecutedCall, AgentLoopError> {
    if let Some(result) = concurrent.get(index)
        && (result.pending_authority.is_none() || Some(index) != resumed_start)
    {
        return Ok(ExecutedCall {
            result: result.result.clone(),
            pending_authority: result.pending_authority.clone(),
        });
    }
    // Concurrent siblings are independent; denial applies only to this call.
    let refusal = refusal.filter(|_| concurrent.is_empty() || Some(index) == resumed_start);
    match refusal {
        Some(refusal) => refuse_call(input, &prepared.call, refusal, position)
            .await
            .map(ExecutedCall::settled),
        None => tool_batch::execute(input.policy, GuidedInvocation::from(input), prepared)
            .await
            .map_err(propagated),
    }
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
    super::super::progress::authority_terminal(input.progress, call, Status::Cancelled).await;
    Ok(result)
}

/// A sequential batch stopped at a call that waits for an authority decision.
pub(super) struct ParkedBatch<'a> {
    call_id: Option<String>,
    request_ref: String,
    call: &'a ModelRoundToolCall,
    next_call_index: usize,
    results: Vec<ToolResult>,
    concurrent_results: Vec<ExecutedCall>,
    concurrent_call_ids: Vec<String>,
    pending_modifications: Vec<String>,
    first_suspension: Option<SuspensionReason>,
}

/// Failed parking settles the pending rows without altering completed siblings.
async fn park_batch(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    batch: &ToolBatch<'_>,
    parked: ParkedBatch<'_>,
) -> Result<Step, AgentLoopError> {
    let start = parked.next_call_index;
    let pending: Vec<_> = parked
        .concurrent_results
        .iter()
        .map(|result| result.pending_authority.is_some())
        .collect();
    let completed = state.tool_results.clone();
    let result = suspend_for_authority(input, state, prepared, batch, parked).await;
    if result.is_err() {
        state.tool_results = completed;
        for (index, call) in batch.calls.iter().enumerate().skip(start) {
            if index == start || pending.get(index) == Some(&true) {
                super::super::progress::authority_terminal(input.progress, call, Status::Failed)
                    .await;
            }
        }
    }
    result.map(Step::finished)
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
        .or(parked.call_id)
        .filter(|call_id| !call_id.is_empty())
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
    let mut extensions = serde_json::Map::new();
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
        call_id,
        messages: std::mem::take(&mut state.messages),
        next_item_ordinal: state.next_item_ordinal,
        provider_continuation: state.provider_continuation.take(),
        instructions: prepared.instructions.clone(),
        stable_provider_cache_prefix: prepared.request.stable_provider_cache_prefix.clone(),
        model_round_index: state.model_round_index,
        iteration: batch.iteration,
        empty_response_recovery_used: state.empty_recovery_used,
        automatic_continuations: state.automatic_continuations,
        stop_hook_active: state.stop_hook_active,
        feedback_counts: std::mem::take(&mut state.feedback_counts),
        tool_results: std::mem::take(&mut state.tool_results),
        presentation,
        batch: AuthorityBatch {
            tools: batch.tools.to_vec(),
            calls: batch.calls.to_vec(),
            next_call_index: parked.next_call_index,
            results: parked.results,
            concurrent_results: parked
                .concurrent_results
                .into_iter()
                .map(|executed| executed.result)
                .collect(),
            concurrent_call_ids: parked.concurrent_call_ids,
            pending_modifications: parked.pending_modifications,
            first_suspension: parked.first_suspension,
        },
        extensions,
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
