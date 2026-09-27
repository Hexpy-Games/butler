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

mod batch;
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
    discard_round_text(prepared);
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

/// Tells the stream relay that the latest round's streamed text is not the
/// answer, so a stopped turn does not keep it as its partial answer.
fn discard_round_text(prepared: &PreparedPolicy) {
    if let Some(observer) = prepared.ports.stream_observer.as_deref() {
        observer.round_text_discarded();
    }
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
        discard_round_text(prepared);
        text = synthesized;
    }
    if text.is_empty() && !state.empty_recovery_used {
        discard_round_text(prepared);
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
            discard_round_text(prepared);
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
