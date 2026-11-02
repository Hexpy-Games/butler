//! The agent loop: model rounds and tool batches until the turn answers or suspends.
//!
//! One iteration opens (cancellation, steering), obtains the assistant reply
//! (a model round, or a replayed batch/call on resume), and then either
//! settles a final answer or runs the requested tool batch.

use crate::btcc::BtccCode;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[cfg(any(test, feature = "test-support"))]
use crate::btcc::StateExecutionClaim;
use crate::btcc::{
    AgentLoopError, AgentLoopProgress, AgentLoopResult, SuspensionReason, TurnRecord,
};

use super::completion::{Ending, OutcomeCheck, after_batch, finish, finish_outcome, record_result};
use super::continuation::{
    AuthorityBatch, AuthorityLoopContinuation, Refusal, RefusedCall, unexecuted_call,
};
use super::contracts::{
    AgentLoopEvent, AuthorityDecision, BatchDisposition, CandidateDisposition, ModelRoundMessage,
    ModelRoundTool, ModelRoundToolCall, PreparedPolicy, SemanticTurn, TextCallDisposition,
    ToolResult, ToolSurface,
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

mod answer;
mod batch;
mod final_report;
use answer::*;
use batch::*;

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
    nonfinal: bool,
    stop: crate::btcc::ModelStop,
    provider_content_progress: bool,
    text: String,
    calls: Vec<ModelRoundToolCall>,
    /// Tool names the model wrote as text, sorted and deduplicated.
    text_call_names: Vec<String>,
}

impl Reply {
    fn is_paused(&self) -> bool {
        self.stop == crate::btcc::ModelStop::Paused
    }

    fn is_cut(&self) -> bool {
        matches!(
            self.stop,
            crate::btcc::ModelStop::Paused | crate::btcc::ModelStop::Truncated
        )
    }
}

/// Runs the model/tool loop for one admitted turn until it answers or suspends.
pub(super) async fn run(mut input: Invocation<'_>) -> Result<AgentLoopResult, AgentLoopError> {
    let timing = super::command_timing::CommandTiming::new("loop_preparation");
    let mut prepared = match input.policy.prepare(GuidedInvocation::from(&input)).await {
        Ok(prepared) => prepared,
        Err(error) => {
            super::progress::fail_pending_except(&input, &[]).await;
            return Err(propagated(error));
        }
    };
    timing.mark("policy_prepared");
    let mut state = match restore_state(&mut input, &mut prepared) {
        Ok(state) => state,
        Err(error) => {
            super::progress::fail_pending_except(&input, &[]).await;
            return Err(error);
        }
    };
    let context = match input
        .policy
        .begin_context(GuidedInvocation::from(&input), input.budget.clone())
        .await
    {
        Ok(context) => context,
        Err(error) => {
            super::progress::fail_pending(&input, &state).await;
            return Err(propagated(error));
        }
    };
    timing.mark("context_begun");
    loop {
        let step = match run_iteration(&input, &mut state, &prepared, context.as_ref()).await {
            Err(AgentLoopError::Propagate(error))
                if error.code() == "turn_continuation_budget_exhausted" =>
            {
                super::progress::fail_pending(&input, &state).await;
                return finish_limit(&input, &state, error.message()).await;
            }
            Err(error) => {
                super::progress::fail_pending(&input, &state).await;
                return Err(error);
            }
            Ok(step) => step,
        };
        match step {
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
    let timing = super::command_timing::CommandTiming::new("loop_iteration");
    cancelled(&input.cancellation)?;
    let iteration = state.begin_iteration();
    let resumed_batch = state.resumed_batch.take();
    if !state.is_replaying(resumed_batch.as_ref()) {
        observe_steering(input, state).await?;
    }
    timing.mark("steering_done");
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
    timing.mark("tools_resolved");
    let reply = match &resumed_batch {
        Some(batch) => Reply {
            nonfinal: false,
            stop: crate::btcc::ModelStop::Complete,
            provider_content_progress: false,
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
    if reply.is_paused() {
        return settle_answer(input, state, prepared, reply, iteration).await;
    }
    if let Some(step) =
        final_report::reject_tools(input, state, prepared, &reply, iteration).await?
    {
        return Ok(step);
    }
    if let Some(step) = reject_text_tool_calls(input, state, prepared, &reply, iteration).await? {
        return Ok(step);
    }
    if reply.calls.is_empty() {
        return settle_answer(input, state, prepared, reply, iteration).await;
    }
    discard_round_text(prepared);
    state.cut_answer.clear();
    state.answer_continuation = false;
    if let Some(observer) = prepared.ports.stream_observer.as_deref() {
        observer.round_text_continued("");
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
        .before_model_round(GuidedInvocation::from(input), state.phase)
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
            nonfinal: false,
            stop: crate::btcc::ModelStop::Complete,
            provider_content_progress: false,
            text: String::new(),
            calls: vec![call],
            text_call_names: Vec::new(),
        });
    }
    let result = run_model_round(input, state, prepared, iteration, surface, context).await?;
    let raw_text = result.text.as_deref().unwrap_or_default();
    let continuing = !state.cut_answer.is_empty()
        || matches!(
            result.stop,
            crate::btcc::ModelStop::Truncated | crate::btcc::ModelStop::Paused
        );
    let text = if continuing {
        result.continuation_text.as_deref().unwrap_or(raw_text)
    } else {
        raw_text.trim()
    }
    .to_owned();
    let provider_content_progress = new_provider_content(state, result.assistant_message.as_ref());
    let calls = result.tool_calls;
    let mut text_call_names = result.text_tool_call_names;
    text_call_names.sort();
    text_call_names.dedup();
    // Preserve paused provider content (including server tool blocks), never an empty assistant.
    let has_provider_content = result.stop == crate::btcc::ModelStop::Paused
        && result.assistant_message.as_ref().is_some_and(|message| {
            message
                .provider_data
                .as_ref()
                .and_then(Value::as_array)
                .is_some_and(|blocks| {
                    blocks.iter().any(|b| {
                        b["type"] != "text" || b["text"].as_str().is_some_and(|t| !t.is_empty())
                    })
                })
        });
    if !text.is_empty() || !calls.is_empty() || has_provider_content {
        let message = result
            .assistant_message
            .unwrap_or_else(|| assistant_message(text.clone(), calls.clone(), result.raw));
        state.messages.push(message);
    }
    Ok(Reply {
        nonfinal: result.nonfinal,
        stop: result.stop,
        provider_content_progress,
        text,
        calls,
        text_call_names,
    })
}

/// Provider blocks are opaque: any newly added nonempty block advances a pause.
fn new_provider_content(state: &State, message: Option<&ModelRoundMessage>) -> bool {
    message
        .and_then(|m| m.provider_data.as_ref())
        .and_then(Value::as_array)
        .is_some_and(|blocks| {
            blocks.iter().any(|block| {
                (block["type"] != "text" || block["text"].as_str().is_some_and(|s| !s.is_empty()))
                    && !state
                        .messages
                        .iter()
                        .filter_map(|m| m.provider_data.as_ref())
                        .filter_map(Value::as_array)
                        .flatten()
                        .any(|previous| previous == block)
            })
        })
}

/// Tells the stream relay that the latest round's streamed text is not the
/// answer, so a stopped turn does not keep it as its partial answer.
fn discard_round_text(prepared: &PreparedPolicy) {
    if let Some(observer) = prepared.ports.stream_observer.as_deref() {
        observer.round_text_discarded();
    }
}

/// Preserve prose tool calls as evidence and ask the model for the native format.
async fn reject_text_tool_calls(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    reply: &Reply,
    iteration: u32,
) -> Result<Option<Step>, AgentLoopError> {
    if reply.text_call_names.is_empty() {
        return Ok(None);
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
        TextCallDisposition::Continue(observation) => {
            if reply.calls.is_empty() {
                return continue_answer(input, state, prepared, &observation)
                    .await
                    .map(Some);
            }
            let observation = state.feedback(&observation);
            state
                .messages
                .push(ModelRoundMessage::user(observation, None));
            Ok(None)
        }
        TextCallDisposition::Fail(error) => Err(propagated(error)),
    }
}
