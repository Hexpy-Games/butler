use crate::btcc::{AgentLoopError, BtccError};

use super::contracts::{
    AgentLoopEvent, ContextMessages, ModelRoundRequest, ModelRoundResult, PreparedPolicy,
    ReplayPreparation,
};
use super::driver::Invocation;
use super::guided_ports::GuidedInvocation;
use super::operation_result_replay::OperationResultError;
use super::ports::{ModelRoundError, propagated, runtime};
use super::progress::{Status, model_waiting};
use super::state::{
    State, append_observations, emit, identify_messages, identify_response, next_item_id,
};
use crate::btcc::BtccCode;

enum AttemptError {
    Model(ModelRoundError),
    ContextModel(ModelRoundError),
    Contract(BtccError),
}

pub(super) async fn run_model_round(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    iteration: u32,
    tools: &mut Vec<super::contracts::ModelRoundTool>,
    surface_digest: &mut Option<String>,
    context: &dyn super::guided_ports::TurnContextProjection,
) -> Result<ModelRoundResult, AgentLoopError> {
    let round_index = prepared
        .usage_attribution
        .as_ref()
        .and_then(|value| value.round_index)
        .unwrap_or(0)
        .saturating_add(state.model_round_index);
    state.model_round_index = state.model_round_index.saturating_add(1);
    let usage_attribution = prepared.usage_attribution.as_ref().map(|attribution| {
        let mut value = attribution.clone();
        value.round_index = Some(round_index);
        value
    });
    let round_id = if input.recovery_attempt > 1 {
        format!(
            "btcc-model-round-{round_index}:retry:{}",
            input.recovery_attempt
        )
    } else {
        format!("btcc-model-round-{round_index}")
    };
    let started_model_ref = input.model_execution.active_model_ref();
    model_waiting(
        input.progress,
        &round_id,
        Status::Started,
        Some(&started_model_ref),
    )
    .await;

    let mut response_item_id = String::new();
    let attempt: Result<ModelRoundResult, AttemptError> = async {
        identify_messages(&mut state.messages, &mut state.next_item_ordinal);
        response_item_id = next_item_id(&mut state.next_item_ordinal);
        let replay = if let Some(runtime) = input.operation_results {
            runtime
                .prepare(
                    &round_id,
                    &state.messages,
                    input.model,
                    prepared.butler_data.as_deref(),
                )
                .await
                .map_err(replay_error)?
        } else {
            ReplayPreparation { messages: None }
        };
        let base_messages = replay.messages.as_deref().unwrap_or(&state.messages);
        let context_model_ref = input.model_execution.active_model_ref();
        let mut projection = input
            .policy
            .prepare_context(
                context,
                GuidedInvocation::from(input),
                context_input(
                    input,
                    prepared,
                    ContextProjectionSource {
                        model_ref: &context_model_ref,
                        round_id: &round_id,
                        response_item_id: &response_item_id,
                        semantic_messages: &state.messages,
                        transport_messages: base_messages,
                        tools,
                        final_report: state.final_report,
                    },
                ),
            )
            .await
            .map_err(context_error)?;
        if projection.requires_rebase && projection.recheck_steering_on_rebase {
            let observations = input
                .policy
                .before_model_round(GuidedInvocation::from(input))
                .await
                .map_err(AttemptError::Contract)?;
            if !observations.is_empty() {
                let reopens_tools = observations
                    .iter()
                    .any(|value| value.request_segment_kind == "current_user_request");
                append_observations(state, observations);
                if reopens_tools {
                    state.final_report = false;
                    (*tools, *surface_digest) = input
                        .policy
                        .resolve_tools(GuidedInvocation::from(input), &prepared.tools, false)
                        .await
                        .map_err(AttemptError::Contract)?;
                }
                response_item_id = next_item_id(&mut state.next_item_ordinal);
                let context_model_ref = input.model_execution.active_model_ref();
                projection = input
                    .policy
                    .prepare_context(
                        context,
                        GuidedInvocation::from(input),
                        context_input(
                            input,
                            prepared,
                            ContextProjectionSource {
                                model_ref: &context_model_ref,
                                round_id: &round_id,
                                response_item_id: &response_item_id,
                                semantic_messages: &state.messages,
                                transport_messages: replay
                                    .messages
                                    .as_deref()
                                    .unwrap_or(&state.messages),
                                tools,
                                final_report: state.final_report,
                            },
                        ),
                    )
                    .await
                    .map_err(context_error)?;
            }
        }
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
        emit(input.observer, &AgentLoopEvent::ModelCall { iteration });
        let request_model_ref = input.model_execution.active_model_ref();
        let request = ModelRoundRequest {
            max_output_tokens: prepared.max_output_tokens,
            round_id: Some(&round_id),
            model: &request_model_ref,
            messages,
            instructions: prepared.instructions.as_deref(),
            tools,
            tool_surface_digest: surface_digest.as_deref(),
            tool_choice: active_tool_choice(prepared.tool_choice, state.final_report),
            reasoning_effort: &input.semantic.model.reasoning_effort,
            cancellation: input.cancellation.clone(),
            attachments: &prepared.attachments,
            image_carrier: prepared.image_carrier.as_ref(),
            image_capability: prepared.image_capability.as_ref(),
            image_manifests: &prepared.image_manifests,
            verified_image_payload: prepared.verified_image_payload.as_deref(),
            butler_data: prepared.butler_data.as_deref(),
            usage_attribution: usage_attribution.as_ref(),
            cache_scope: prepared.cache_scope.as_deref(),
            stable_provider_cache_prefix: prepared.stable_provider_cache_prefix.as_ref(),
            route_context: prepared.route_context.as_ref(),
            provider_retry_attempts: Some(1.0),
            route_transport_attempt_ordinal: prepared.route_transport_attempt_ordinal,
            continuation: state.provider_continuation.as_ref(),
            bounded_continuation: bounded_continuation.as_ref(),
            provider_body_admission: projection.provider_body_admission.as_deref(),
            stream_observer: prepared.stream_observer.as_deref(),
            identity_observer: prepared.identity_observer.as_deref(),
        };
        input.model_round_observer.request(&request).await;
        let mut response = input
            .model
            .run_round(request)
            .await
            .map_err(AttemptError::Model)?;
        input.model_round_observer.response(&response).await;
        if let Some(runtime) = input.operation_results {
            runtime
                .accepted(&round_id, &response)
                .await
                .map_err(replay_error)?;
        }
        if let Some(budget) = &input.budget {
            budget
                .record_output(&round_id, model_round_output_bytes(&response)?)
                .await
                .map_err(AttemptError::Contract)?;
        }
        state.provider_continuation = response.continuation.take();
        let completed_model_ref = input.model_execution.active_model_ref();
        model_waiting(
            input.progress,
            &round_id,
            Status::Completed,
            Some(&completed_model_ref),
        )
        .await;
        identify_response(&mut response, response_item_id.clone());
        emit(
            input.observer,
            &AgentLoopEvent::ModelResponse {
                iteration,
                text: response.text.clone(),
            },
        );
        Ok(response)
    }
    .await;

    match attempt {
        Ok(response) => Ok(response),
        Err(original) => {
            if let AttemptError::Model(error) = &original {
                input.model_round_observer.failure(error).await;
            }
            if let Some(results) = input.operation_results {
                results
                    .failed(&round_id)
                    .await
                    .map_err(|error| map_attempt(replay_error(error), input, iteration))?;
            }
            let failed_model_ref = input.model_execution.active_model_ref();
            model_waiting(
                input.progress,
                &round_id,
                if input.cancellation.is_cancelled() {
                    Status::Cancelled
                } else {
                    Status::Failed
                },
                Some(&failed_model_ref),
            )
            .await;
            Err(map_attempt(original, input, iteration))
        }
    }
}

fn model_round_output_bytes(result: &ModelRoundResult) -> Result<u64, AttemptError> {
    let assistant = result.assistant_message.as_ref();
    let mut encoded = String::from("{\"role\":\"assistant\",\"content\":");
    crate::json::write_string(
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
    crate::json::append_json(&calls, &mut encoded).map_err(output_serialization_error)?;
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
    final_report: bool,
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
        tool_choice: active_tool_choice(prepared.tool_choice, source.final_report),
        attachments: &prepared.attachments,
        butler_data: prepared.butler_data.as_deref(),
        max_model_facing_bytes: crate::btcc::continuation_budget::model_context_byte_limit(
            input.semantic.model.context_window_tokens,
        ),
    }
}

fn active_tool_choice(
    choice: Option<super::contracts::ToolChoice>,
    final_report: bool,
) -> Option<super::contracts::ToolChoice> {
    if final_report { None } else { choice }
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
