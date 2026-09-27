use serde_json::Value;

use crate::btcc::{
    AgentLoopError, AgentLoopResult, ExecutionRoute, SuspensionReason, TerminalOutcome,
};
use butler_core::tool_protocol::ToolName;

use super::contracts::{AgentLoopEvent, BatchDisposition, CloseoutInput, ToolOutcome, ToolResult};
use super::driver::Invocation;
use super::guided_ports::GuidedInvocation;
use super::ports::propagated;
use super::state::{State, emit};

/// Whether a recorded tool result may still end the loop early.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum OutcomeCheck {
    /// Ask the policy whether the result suspends the turn.
    Evaluate,
    /// Record only; an earlier result in the batch already decided the outcome.
    RecordOnly,
}

/// How a loop execution ends.
pub(super) enum Ending<'a> {
    /// The turn answers with this content (possibly empty).
    Answer(&'a str),
    /// The turn suspends for a reason that carries no continuation.
    Suspend(SuspensionReason),
    /// The turn suspends on a pending authority request with this serialized
    /// `AuthorityLoopContinuation`.
    AwaitAuthority(Value),
}

/// Records one tool result in the transcript and asks the policy whether it
/// ends the loop.
pub(super) async fn record_result(
    input: &Invocation<'_>,
    state: &mut State,
    call: &super::contracts::ModelRoundToolCall,
    result: ToolResult,
    iteration: u32,
    check: OutcomeCheck,
) -> Result<Option<ToolOutcome>, AgentLoopError> {
    state.tool_results.push(result.clone());
    let operation_call_id = input.policy.operation_result_call_id(&call.id);
    let references = if let Some(runtime) = input.operation_results {
        runtime
            .references_for_call(&call.name, operation_call_id.as_deref())
            .await
            .map_err(propagated)?
    } else {
        super::operation_result_replay::OperationResultMessageReferences {
            operation_result_call_id: operation_call_id.clone(),
            ..Default::default()
        }
    };
    let message = input
        .policy
        .tool_result_message(input.turn, &result, &references)
        .await
        .map_err(propagated)?;
    state.messages.push(message);
    super::state::identify_messages(&mut state.messages, &mut state.next_item_ordinal);
    emit(
        input.observer,
        &AgentLoopEvent::ToolResult {
            iteration,
            result: result.clone(),
        },
    );
    if !result.ok || check == OutcomeCheck::RecordOnly {
        return Ok(None);
    }
    input
        .policy
        .outcome_from_tool_result(GuidedInvocation::from(input), call, &result)
        .await
        .map_err(propagated)
}

pub(super) async fn after_batch(
    input: &Invocation<'_>,
    calls: &[super::contracts::ModelRoundToolCall],
    results: &[ToolResult],
    iteration: u32,
) -> Result<BatchDisposition, AgentLoopError> {
    input
        .policy
        .after_tool_batch(GuidedInvocation::from(input), calls, results, iteration)
        .await
        .map_err(propagated)
}

pub(super) async fn finish_outcome(
    input: &Invocation<'_>,
    state: &State,
    outcome: Option<ToolOutcome>,
) -> Result<Option<AgentLoopResult>, AgentLoopError> {
    match outcome {
        Some(ToolOutcome::Suspend(reason)) => finish(input, state, Ending::Suspend(reason))
            .await
            .map(Some),
        None => Ok(None),
    }
}

/// Closes the execution out through the policy and assembles the loop result.
pub(super) async fn finish(
    input: &Invocation<'_>,
    state: &State,
    ending: Ending<'_>,
) -> Result<AgentLoopResult, AgentLoopError> {
    let (content, suspension, authority_continuation) = match ending {
        Ending::Answer(content) => (content, None, None),
        Ending::Suspend(reason) => ("", Some(reason), None),
        Ending::AwaitAuthority(continuation) => (
            "",
            Some(SuspensionReason::AuthorityPending),
            Some(continuation),
        ),
    };
    let closeout = input
        .policy
        .closeout(
            GuidedInvocation::from(input),
            CloseoutInput {
                content,
                suspension,
            },
        )
        .await
        .map_err(propagated)?;
    let route = route(&state.used_tools, closeout.has_final_work);
    let terminal_outcome = (suspension.is_none()
        && closeout.runtime_failure.is_none()
        && closeout.content.trim().is_empty()
        && input.semantic.context.empty_response_policy
            == Some(super::contracts::EmptyResponsePolicy::TypedTerminal))
    .then_some(TerminalOutcome::NoVisible);
    Ok(AgentLoopResult {
        route,
        content: closeout.content,
        terminal_outcome,
        suspension,
        authority_continuation,
        work_status: closeout.work_status,
        accepted_work_result: closeout.accepted_work_result,
        runtime_failure: closeout
            .runtime_failure
            .or_else(|| state.runtime_failure.clone()),
        artifacts: closeout.artifacts,
        changed_files: closeout.changed_files,
        plan: closeout.plan,
        model_identity: closeout.model_identity,
    })
}

fn route(used_tools: &[String], has_final_work: bool) -> ExecutionRoute {
    if has_final_work || used_tools.iter().any(|name| durable_work_tool(name)) {
        ExecutionRoute::Managed
    } else if used_tools.is_empty() {
        ExecutionRoute::Direct
    } else {
        ExecutionRoute::Assisted
    }
}

fn durable_work_tool(name: &str) -> bool {
    matches!(
        ToolName::parse(name),
        Some(
            ToolName::StartWork
                | ToolName::ContinueWork
                | ToolName::ReplaceWorkPlan
                | ToolName::RecordWorkCheckpoint
                | ToolName::RecordWorkReview
                | ToolName::RecordWorkDisposition
        )
    )
}
