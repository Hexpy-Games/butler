//! Actual per-Turn bounded model context and rolling-summary owner.

mod atomic_units;
mod bounded;
mod compaction;
mod serialization;
mod summary;

use std::sync::Arc;

use tokio::sync::Mutex;

use crate::btcc::{
    BoundedContinuationEnvelope, BoundedEnvelopeV1, BtccError, ContextCompactionRepository,
    ContextMessages, ContextPort, ContextProjection, ContextProjectionError,
    ContextProjectionInput, ContextProjectionRebaseIdentity, ContextSizingRequest,
    GuidedInvocation, ModelRoundError, ModelRoundMessage, ModelRoundRequest, PortFuture,
    ProviderBodyAdmissionPort, SteeringObservation, TurnContextProjection,
    TurnContinuationBudgetPort, TurnSteeringPort, UsageAttribution,
};

use compaction::CompactionState;
use serialization::{MessageProjection, messages_json, request_for_messages, request_json};
use summary::{SummaryPort, SummaryRequest, SummarySizing};

pub(crate) struct NativeContextPort {
    steering: Arc<dyn TurnSteeringPort>,
    compactions: Option<ContextCompactionRepository>,
}

impl NativeContextPort {
    pub(crate) fn new(
        steering: Arc<dyn TurnSteeringPort>,
        compactions: Option<ContextCompactionRepository>,
    ) -> Self {
        Self {
            steering,
            compactions,
        }
    }
}

impl ContextPort for NativeContextPort {
    fn steering<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Vec<SteeringObservation>> {
        self.steering.observe(invocation)
    }

    fn begin_turn<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        budget: Option<Arc<dyn TurnContinuationBudgetPort>>,
    ) -> PortFuture<'a, Box<dyn TurnContextProjection + 'a>> {
        Box::pin(async move {
            let state = match &self.compactions {
                Some(repository) => Some(Mutex::new(CompactionState::new(
                    repository.load(&invocation.turn.turn_id).await?,
                ))),
                None => None,
            };
            Ok(Box::new(NativeTurnContext {
                turn_id: invocation.turn.turn_id.clone(),
                repository: self.compactions.clone(),
                state,
                budget,
            }) as Box<dyn TurnContextProjection>)
        })
    }
}

struct NativeTurnContext {
    turn_id: String,
    repository: Option<ContextCompactionRepository>,
    state: Option<Mutex<CompactionState>>,
    budget: Option<Arc<dyn TurnContinuationBudgetPort>>,
}

impl TurnContextProjection for NativeTurnContext {
    fn project<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        input: ContextProjectionInput<'a>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<ContextProjection, ContextProjectionError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.project_round(invocation, input).await })
    }
}

impl NativeTurnContext {
    async fn project_round(
        &self,
        invocation: GuidedInvocation<'_>,
        input: ContextProjectionInput<'_>,
    ) -> Result<ContextProjection, ContextProjectionError> {
        let selected_limit = self
            .budget
            .as_ref()
            .map_or(input.max_model_facing_bytes, |budget| {
                budget.limits().max_model_facing_bytes
            });
        let empty_messages = "[]";
        let overhead = request_json(
            input.instructions,
            input.tools,
            input.tool_choice,
            empty_messages,
        )
        .map_err(ContextProjectionError::Contract)?
        .len();
        let message_limit = usize::try_from(selected_limit)
            .unwrap_or(usize::MAX)
            .saturating_sub(overhead)
            .max(1);

        let (owned_messages, identity, requires_rebase, projected_message_bytes) = match &self.state
        {
            Some(state) => {
                self.compacted(state, invocation, &input, message_limit)
                    .await?
            }
            None => self.bounded(&input, message_limit)?,
        };
        let projected = owned_messages
            .as_deref()
            .unwrap_or(if self.state.is_some() {
                input.semantic_messages
            } else {
                input.transport_messages
            });
        let request = request_for_messages(
            input.instructions,
            input.tools,
            input.tool_choice,
            projected,
        )
        .map_err(ContextProjectionError::Contract)?;
        let request_digest = serialization::digest(&request);
        let model_facing_bytes = u64::try_from(overhead.saturating_add(projected_message_bytes))
            .map_err(|_| {
                ContextProjectionError::Contract(BtccError::relayed(
                    "invalid_model_facing_byte_limit",
                    "model-facing request byte count is out of range",
                ))
            })?;
        let envelope = BoundedContinuationEnvelope {
            schema_version: BoundedEnvelopeV1::V1,
            model_facing_bytes,
            request_digest: request_digest.clone(),
            response_item_id: input.response_item_id.into(),
            context_projection: identity,
        };
        let admission = self.budget.as_ref().map(|budget| {
            Box::new(BudgetAdmission {
                budget: budget.clone(),
                round_id: input.round_id.into(),
                request_digest,
            }) as Box<dyn ProviderBodyAdmissionPort>
        });
        let messages = match owned_messages {
            Some(messages) => ContextMessages::Owned(messages),
            None if self.state.is_some() => ContextMessages::Semantic,
            None => ContextMessages::Transport,
        };
        Ok(ContextProjection {
            messages,
            bounded_continuation: Some(envelope),
            provider_body_admission: admission,
            requires_rebase,
            recheck_steering_on_rebase: self.state.is_some(),
        })
    }

    fn bounded(
        &self,
        input: &ContextProjectionInput<'_>,
        message_limit: usize,
    ) -> Result<ProjectionParts, ContextProjectionError> {
        let units = atomic_units::build(input.transport_messages)
            .map_err(ContextProjectionError::Contract)?;
        let projection = bounded::project(input.transport_messages, &units, message_limit)
            .map_err(ContextProjectionError::Contract)?;
        let changed = projection.evicted_atomic_units > 0 || projection.compacted_atomic_units > 0;
        Ok((
            projection.messages,
            None,
            changed,
            projection.model_facing_bytes,
        ))
    }

    async fn compacted(
        &self,
        state: &Mutex<CompactionState>,
        invocation: GuidedInvocation<'_>,
        input: &ContextProjectionInput<'_>,
        message_limit: usize,
    ) -> Result<ProjectionParts, ContextProjectionError> {
        let model = invocation.model_execution.routed();
        let sizing = model
            .context_sizing(ContextSizingRequest {
                model: input.model_ref,
                instructions: input.instructions,
                tools: input.tools,
                attachments: input.attachments,
                max_output_tokens: None,
                butler_data: input.butler_data,
            })
            .map_err(ContextProjectionError::Model)?;
        let message_bytes = |messages: &[ModelRoundMessage]| match model
            .stateless_message_bytes(messages, input.butler_data)
            .map_err(ContextProjectionError::Model)?
        {
            Some(bytes) => Ok(bytes),
            None => messages_json(messages.iter(), MessageProjection::Exact)
                .map_err(ContextProjectionError::Contract)
                .map(|json| json.len()),
        };
        let measure = |messages: &[ModelRoundMessage]| {
            let stateless = message_bytes(messages)? as f64;
            let pressure = match &sizing {
                Some(sizing) => {
                    (sizing.measure)(messages).map_err(ContextProjectionError::Contract)?
                        * message_limit as f64
                        / sizing.max_message_bytes
                }
                None => 0.0,
            };
            Ok(stateless.max(pressure))
        };
        let mut state = state.lock().await;
        let summary = RoundSummary {
            invocation,
            model_for_sizing: invocation.model_execution.active_model_ref(),
            butler_data: input.butler_data,
        };
        let projection = state
            .prepare(
                input.semantic_messages,
                message_limit as f64,
                &measure,
                &summary,
            )
            .await?;
        if let Some(record) = &projection.save_record {
            let Some(repository) = self.repository.as_ref() else {
                return Err(ContextProjectionError::Contract(BtccError::relayed(
                    "context_compaction_repository_missing",
                    "Compaction state requires a repository",
                )));
            };
            repository
                .save(&self.turn_id, record)
                .await
                .map_err(ContextProjectionError::Contract)?;
        }
        let projected = projection
            .messages
            .as_deref()
            .unwrap_or(input.semantic_messages);
        let projected_message_bytes = message_bytes(projected)?;
        let requires_rebase = projection.identity.is_some();
        Ok((
            projection.messages,
            projection.identity,
            requires_rebase,
            projected_message_bytes,
        ))
    }
}

type ProjectionParts = (
    Option<Vec<ModelRoundMessage>>,
    Option<ContextProjectionRebaseIdentity>,
    bool,
    usize,
);

struct BudgetAdmission {
    budget: Arc<dyn TurnContinuationBudgetPort>,
    round_id: String,
    request_digest: String,
}

impl ProviderBodyAdmissionPort for BudgetAdmission {
    fn admit(
        &self,
        serialized_bytes: usize,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ModelRoundError>> + Send + '_>>
    {
        Box::pin(async move {
            let bytes = u64::try_from(serialized_bytes).map_err(|_| {
                ModelRoundError::Integrity(BtccError::relayed(
                    "invalid_model_facing_byte_limit",
                    "provider request byte count is out of range",
                ))
            })?;
            self.budget
                .admit_request(&self.round_id, &self.request_digest, bytes)
                .await
                .map_err(ModelRoundError::Integrity)
        })
    }
}

struct RoundSummary<'a> {
    invocation: GuidedInvocation<'a>,
    model_for_sizing: String,
    butler_data: Option<&'a str>,
}

impl SummaryPort for RoundSummary<'_> {
    fn sizing(&self) -> Result<Option<SummarySizing<'_>>, ModelRoundError> {
        self.invocation
            .model_execution
            .base()
            .context_sizing(ContextSizingRequest {
                model: &self.model_for_sizing,
                instructions: None,
                tools: &[],
                attachments: &[],
                max_output_tokens: None,
                butler_data: self.butler_data,
            })
            .map(|sizing| {
                sizing.map(|sizing| SummarySizing {
                    max_bytes: sizing.max_message_bytes,
                    measure: Box::new(move |content| (sizing.measure)(&[user_message(content)])),
                })
            })
    }

    fn summarize<'a>(
        &'a self,
        request: SummaryRequest<'a>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, ModelRoundError>> + Send + 'a>,
    > {
        Box::pin(async move {
            let model = self.invocation.model_execution.active_model_ref();
            let base = self.invocation.model_execution.base();
            let capacity = base.context_sizing(ContextSizingRequest {
                model: &model,
                instructions: None,
                tools: &[],
                attachments: &[],
                max_output_tokens: None,
                butler_data: self.butler_data,
            })?;
            let max_output_tokens =
                summary_output_tokens(&model, capacity.as_ref(), request.max_output_bytes);
            let messages = [user_message(request.text)];
            let reasoning = self.invocation.model_execution.selected_reasoning_effort();
            let usage = UsageAttribution {
                turn_id: self.invocation.turn.turn_id.clone(),
                phase: "guided".into(),
                reasoning_effort: None,
                round_index: None,
            };
            let round_id = format!("btcc-summary-{}", request.source_digest);
            let response = base
                .run_round(ModelRoundRequest {
                    max_output_tokens,
                    round_id: Some(&round_id),
                    model: &model,
                    messages: &messages,
                    instructions: None,
                    tools: &[],
                    tool_surface_digest: None,
                    tool_choice: None,
                    reasoning_effort: &reasoning,
                    cancellation: self.invocation.cancellation.clone(),
                    attachments: &[],
                    image_carrier: None,
                    image_capability: None,
                    image_manifests: &[],
                    verified_image_payload: None,
                    butler_data: self.butler_data,
                    usage_attribution: Some(&usage),
                    cache_scope: None,
                    stable_provider_cache_prefix: None,
                    route_context: None,
                    provider_retry_attempts: None,
                    route_transport_attempt_ordinal: None,
                    continuation: None,
                    bounded_continuation: None,
                    provider_body_admission: None,
                    stream_observer: None,
                    identity_observer: None,
                })
                .await?;
            Ok(response.text.unwrap_or_default())
        })
    }
}

fn user_message(content: &str) -> ModelRoundMessage {
    ModelRoundMessage {
        role: crate::btcc::ModelRoundRole::User,
        content: Arc::from(content),
        tool_call_id: None,
        name: None,
        tool_calls: None,
        image_attachments: Vec::new(),
        provider_data: None,
        request_segment_kind: None,
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: None,
    }
}

fn summary_output_tokens(
    model: &str,
    capacity: Option<&crate::btcc::ContextSizing<'_>>,
    max_output_bytes: usize,
) -> Option<f64> {
    if model.starts_with("local/") && capacity.and_then(|value| value.max_output_tokens).is_none() {
        return None;
    }
    let requested = (max_output_bytes as f64 / 4.0).floor().max(16_384.0);
    let context = capacity
        .map(|value| (value.max_message_bytes / 8.0).floor())
        .unwrap_or(f64::INFINITY);
    Some(
        capacity
            .and_then(|value| value.max_output_tokens)
            .unwrap_or(f64::INFINITY)
            .min(context)
            .min(requested)
            .max(1.0),
    )
}

#[cfg(test)]
mod tests;
