use crate::btcc::{AgentLoopError, BtccError};

use super::contracts::{
    AgentLoopEvent, ContextMessages, ContextProjection, ContextRebase, LoopPhase,
    ModelRoundRequest, ModelRoundResult, PreparedPolicy, ReplayPreparation, ToolSurface,
    UsageAttribution,
};
use super::guided_ports::TurnContextProjection;
use super::driver::Invocation;
use super::guided_ports::GuidedInvocation;
use super::operation_result_replay::OperationResultError;
use super::ports::{ModelRoundError, propagated, runtime};
use super::progress::{Status, model_waiting};
use super::state::{
    CURRENT_USER_REQUEST, State, append_observations, emit, identify_messages, identify_response,
    next_item_id,
};
use crate::btcc::BtccCode;

enum AttemptError {
    Model(ModelRoundError),
    ContextModel(ModelRoundError),
    Contract(BtccError),
}

/// The identity of one model round: its id (retry-qualified) and the usage
/// attribution offset by the loop's round count.
struct RoundIdentity {
    round_id: String,
    usage_attribution: Option<UsageAttribution>,
}

/// Runs one model round: projects the context, sends the request, and records
/// acceptance, or releases the round and reports its failure.
pub(super) async fn run_model_round(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    iteration: u32,
    surface: &mut ToolSurface,
    context: &dyn TurnContextProjection,
) -> Result<ModelRoundResult, AgentLoopError> {
    let identity = next_round_identity(input, state, prepared);
    let started_model_ref = input.model_execution.active_model_ref();
    model_waiting(
        input.progress,
        &identity.round_id,
        Status::Started,
        Some(&started_model_ref),
    )
    .await;
    let round = Round {
        input,
        prepared,
        identity: &identity,
        iteration,
        context,
    };
    match attempt_round(&round, state, surface).await {
        Ok(response) => Ok(response),
        Err(error) => Err(fail_round(input, &identity.round_id, iteration, error).await),
    }
}

fn next_round_identity(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
) -> RoundIdentity {
    let attribution = prepared.request.usage_attribution.as_ref();
    let round_index = attribution
        .and_then(|value| value.round_index)
        .unwrap_or(0)
        .saturating_add(state.model_round_index);
    state.model_round_index = state.model_round_index.saturating_add(1);
    let usage_attribution = attribution.map(|attribution| UsageAttribution {
        round_index: Some(round_index),
        ..attribution.clone()
    });
    let round_id = if input.recovery_attempt > 1 {
        format!(
            "btcc-model-round-{round_index}:retry:{}",
            input.recovery_attempt
        )
    } else {
        format!("btcc-model-round-{round_index}")
    };
    RoundIdentity {
        round_id,
        usage_attribution,
    }
}

/// What every step of one round attempt borrows.
struct Round<'r, 'a> {
    input: &'r Invocation<'a>,
    prepared: &'r PreparedPolicy,
    identity: &'r RoundIdentity,
    iteration: u32,
    context: &'r dyn TurnContextProjection,
}

async fn attempt_round(
    round: &Round<'_, '_>,
    state: &mut State,
    surface: &mut ToolSurface,
) -> Result<ModelRoundResult, AttemptError> {
    identify_messages(&mut state.messages, &mut state.next_item_ordinal);
    let mut response_item_id = next_item_id(&mut state.next_item_ordinal);
    let replay = replay_transcript(round, state).await?;
    let mut projection =
        project_context(round, state, &replay, surface, &response_item_id).await?;
    if projection.rebase == ContextRebase::RequiredWithSteeringRecheck
        && steer_after_rebase(round, state, surface).await?
    {
        response_item_id = next_item_id(&mut state.next_item_ordinal);
        projection = project_context(round, state, &replay, surface, &response_item_id).await?;
    }
    let mut response = send_request(round, state, &replay, surface, &projection).await?;
    accept_response(round, state, &mut response, response_item_id).await?;
    Ok(response)
}

/// The operation-result replay of the transcript, when the runtime rewrites it.
async fn replay_transcript(
    round: &Round<'_, '_>,
    state: &State,
) -> Result<ReplayPreparation, AttemptError> {
    let input = round.input;
    let Some(runtime) = input.operation_results else {
        return Ok(ReplayPreparation { messages: None });
    };
    runtime
        .prepare(
            &round.identity.round_id,
            &state.messages,
            input.model,
            round.prepared.request.butler_data.as_deref(),
        )
        .await
        .map_err(replay_error)
}

async fn project_context(
    round: &Round<'_, '_>,
    state: &State,
    replay: &ReplayPreparation,
    surface: &ToolSurface,
    response_item_id: &str,
) -> Result<ContextProjection, AttemptError> {
    let input = round.input;
    let model_ref = input.model_execution.active_model_ref();
    let source = ContextProjectionSource {
        model_ref: &model_ref,
        round_id: &round.identity.round_id,
        response_item_id,
        semantic_messages: &state.messages,
        transport_messages: replay.messages.as_deref().unwrap_or(&state.messages),
        tools: &surface.tools,
        phase: state.phase,
    };
    input
        .policy
        .prepare_context(
            round.context,
            GuidedInvocation::from(input),
            context_input(input, round.prepared, source),
        )
        .await
        .map_err(context_error)
}

/// Re-reads steering after a rebase that may have hidden a new user request.
/// A new request reopens the tool surface. Returns whether anything arrived,
/// in which case the context must be projected again.
async fn steer_after_rebase(
    round: &Round<'_, '_>,
    state: &mut State,
    surface: &mut ToolSurface,
) -> Result<bool, AttemptError> {
    let input = round.input;
    let observations = input
        .policy
        .before_model_round(GuidedInvocation::from(input))
        .await
        .map_err(AttemptError::Contract)?;
    if observations.is_empty() {
        return Ok(false);
    }
    let reopens_tools = observations
        .iter()
        .any(|value| value.request_segment_kind == CURRENT_USER_REQUEST);
    append_observations(state, observations);
    if reopens_tools {
        state.phase = LoopPhase::Working;
        *surface = input
            .policy
            .resolve_tools(
                GuidedInvocation::from(input),
                &round.prepared.tools,
                LoopPhase::Working,
            )
            .await
            .map_err(AttemptError::Contract)?;
    }
    Ok(true)
}

async fn send_request(
    round: &Round<'_, '_>,
    state: &State,
    replay: &ReplayPreparation,
    surface: &ToolSurface,
    projection: &ContextProjection,
) -> Result<ModelRoundResult, AttemptError> {
    let input = round.input;
    let prepared = round.prepared;
    let replay_messages = replay.messages.as_deref().unwrap_or(&state.messages);
    let messages = match &projection.messages {
        ContextMessages::Semantic => state.messages.as_slice(),
        ContextMessages::Transport => replay_messages,
        ContextMessages::Owned(messages) => messages,
    };
    let bounded_continuation = projection
        .bounded_continuation
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| {
            AttemptError::Contract(BtccError::detected(
                BtccCode::BoundedContinuationSerializationFailed,
                error.to_string(),
            ))
        })?;
    emit(
        input.observer,
        &AgentLoopEvent::ModelCall {
            iteration: round.iteration,
        },
    );
    let request_model_ref = input.model_execution.active_model_ref();
    let options = &prepared.request;
    let request = ModelRoundRequest {
        max_output_tokens: options.max_output_tokens,
        round_id: Some(&round.identity.round_id),
        model: &request_model_ref,
        messages,
        instructions: prepared.instructions.as_deref(),
        tools: &surface.tools,
        tool_surface_digest: surface.digest.as_deref(),
        tool_choice: active_tool_choice(prepared.tool_choice, state.phase),
        reasoning_effort: &input.semantic.model.reasoning_effort,
        cancellation: input.cancellation.clone(),
        attachments: &prepared.images.attachments,
        image_carrier: prepared.images.carrier.as_ref(),
        image_capability: prepared.images.capability.as_ref(),
        image_manifests: &prepared.images.manifests,
        verified_image_payload: prepared.ports.verified_image_payload.as_deref(),
        butler_data: options.butler_data.as_deref(),
        usage_attribution: round.identity.usage_attribution.as_ref(),
        cache_scope: options.cache_scope.as_deref(),
        stable_provider_cache_prefix: options.stable_provider_cache_prefix.as_ref(),
        route_context: options.route_context.as_ref(),
        provider_retry_attempts: Some(1.0),
        route_transport_attempt_ordinal: options.route_transport_attempt_ordinal,
        continuation: state.provider_continuation.as_ref(),
        bounded_continuation: bounded_continuation.as_ref(),
        provider_body_admission: projection.provider_body_admission.as_deref(),
        stream_observer: prepared.ports.stream_observer.as_deref(),
        identity_observer: prepared.ports.identity_observer.as_deref(),
    };
    input.model_round_observer.request(&request).await;
    let response = input
        .model
        .run_round(request)
        .await
        .map_err(AttemptError::Model)?;
    input.model_round_observer.response(&response).await;
    Ok(response)
}

/// Records the accepted response with the replay runtime and the turn budget,
/// keeps its provider continuation, and gives it a transcript item id.
async fn accept_response(
    round: &Round<'_, '_>,
    state: &mut State,
    response: &mut ModelRoundResult,
    response_item_id: String,
) -> Result<(), AttemptError> {
    let input = round.input;
    let round_id = &round.identity.round_id;
    if let Some(runtime) = input.operation_results {
        runtime
            .accepted(round_id, response)
            .await
            .map_err(replay_error)?;
    }
    if let Some(budget) = &input.budget {
        budget
            .record_output(round_id, model_round_output_bytes(response)?)
            .await
            .map_err(AttemptError::Contract)?;
    }
    state.provider_continuation = response.continuation.take();
    let completed_model_ref = input.model_execution.active_model_ref();
    model_waiting(
        input.progress,
        round_id,
        Status::Completed,
        Some(&completed_model_ref),
    )
    .await;
    identify_response(response, response_item_id);
    emit(
        input.observer,
        &AgentLoopEvent::ModelResponse {
            iteration: round.iteration,
            text: response.text.clone(),
        },
    );
    Ok(())
}

/// Reports a failed attempt, releases its replay reservation and publishes
/// failure progress. A failing release replaces the original error.
async fn fail_round(
    input: &Invocation<'_>,
    round_id: &str,
    iteration: u32,
    original: AttemptError,
) -> AgentLoopError {
    if let AttemptError::Model(error) = &original {
        input.model_round_observer.failure(error).await;
    }
    if let Some(results) = input.operation_results
        && let Err(error) = results.failed(round_id).await
    {
        return map_attempt(replay_error(error), input, iteration);
    }
    let failed_model_ref = input.model_execution.active_model_ref();
    let status = if input.cancellation.is_cancelled() {
        Status::Cancelled
    } else {
        Status::Failed
    };
    model_waiting(input.progress, round_id, status, Some(&failed_model_ref)).await;
    map_attempt(original, input, iteration)
}

fn model_round_output_bytes(result: &ModelRoundResult) -> Result<u64, AttemptError> {
    let assistant = result.assistant_message.as_ref();
    let mut encoded = String::from("{\"role\":\"assistant\",\"content\":");
    butler_core::json::write_string(
        assistant
            .map(|message| message.content.as_ref())
            .or(result.text.as_deref())
            .unwrap_or(""),
        &mut encoded,
    )
    .map_err(output_serialization_error)?;
    encoded.push_str(",\"toolCalls\":");
    let calls = serde_json::to_value(
        assistant
            .and_then(|message| message.tool_calls.as_deref())
            .unwrap_or(&result.tool_calls),
    )
    .map_err(output_serialization_error)?;
    butler_core::json::append_json(&calls, &mut encoded).map_err(output_serialization_error)?;
    encoded.push('}');
    let bytes = encoded.len();
    u64::try_from(bytes).map_err(|source| {
        AttemptError::Contract(
            BtccError::detected(
                BtccCode::ModelRoundOutputTooLarge,
                "model_round_output_too_large",
            )
            .with_source(source),
        )
    })
}

fn output_serialization_error(
    error: impl std::error::Error + Send + Sync + 'static,
) -> AttemptError {
    AttemptError::Contract(
        BtccError::detected(
            BtccCode::ModelRoundOutputSerializationFailed,
            error.to_string(),
        )
        .with_source(error),
    )
}

#[derive(Clone, Copy)]
struct ContextProjectionSource<'a> {
    model_ref: &'a str,
    round_id: &'a str,
    response_item_id: &'a str,
    semantic_messages: &'a [super::contracts::ModelRoundMessage],
    transport_messages: &'a [super::contracts::ModelRoundMessage],
    tools: &'a [super::contracts::ModelRoundTool],
    phase: LoopPhase,
}

fn context_input<'a>(
    input: &'a Invocation<'_>,
    prepared: &'a PreparedPolicy,
    source: ContextProjectionSource<'a>,
) -> super::contracts::ContextProjectionInput<'a> {
    super::contracts::ContextProjectionInput {
        round_id: source.round_id,
        response_item_id: source.response_item_id,
        semantic_messages: source.semantic_messages,
        transport_messages: source.transport_messages,
        model_ref: source.model_ref,
        instructions: prepared.instructions.as_deref(),
        tools: source.tools,
        tool_choice: active_tool_choice(prepared.tool_choice, source.phase),
        attachments: &prepared.images.attachments,
        butler_data: prepared.request.butler_data.as_deref(),
        max_model_facing_bytes: crate::btcc::continuation_budget::model_context_byte_limit(
            input.semantic.model.context_window_tokens,
        ),
    }
}

/// The final-report round never forces a tool choice.
fn active_tool_choice(
    choice: Option<super::contracts::ToolChoice>,
    phase: LoopPhase,
) -> Option<super::contracts::ToolChoice> {
    match phase {
        LoopPhase::Working => choice,
        LoopPhase::FinalReport => None,
    }
}

fn replay_error(error: OperationResultError) -> AttemptError {
    match error {
        OperationResultError::Model(error) => AttemptError::Model(error),
        OperationResultError::Contract(error) => AttemptError::Contract(error),
    }
}

fn context_error(error: super::ports::ContextProjectionError) -> AttemptError {
    match error {
        super::ports::ContextProjectionError::Model(error) => AttemptError::ContextModel(error),
        super::ports::ContextProjectionError::Contract(error) => AttemptError::Contract(error),
    }
}

fn map_attempt(error: AttemptError, input: &Invocation<'_>, iteration: u32) -> AgentLoopError {
    match error {
        AttemptError::Contract(error) => propagated(error),
        AttemptError::ContextModel(error) => reduced(error),
        AttemptError::Model(error) => {
            let mapped = reduced(error);
            let code = match &mapped {
                AgentLoopError::Runtime(failure) => failure.code.clone(),
                AgentLoopError::Propagate(error) => error.code().to_owned(),
            };
            emit(
                input.observer,
                &AgentLoopEvent::ModelFailure { iteration, code },
            );
            mapped
        }
    }
}

fn reduced(error: ModelRoundError) -> AgentLoopError {
    use crate::btcc::model_route::ReducedModelError;

    match crate::btcc::model_route::reduce_model_error(error) {
        ReducedModelError::Operational(failure) => runtime(failure),
        ReducedModelError::Integrity(error) => propagated(error),
    }
}
