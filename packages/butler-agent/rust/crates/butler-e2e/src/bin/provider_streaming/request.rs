use butler_models::models::*;
use butler_turn::btcc::*;
use tokio_util::sync::CancellationToken;

pub(super) async fn request(
    provider: &ModelProvider,
    model: &str,
    messages: &[ModelRoundMessage],
    observer: &super::Events,
    attempts: f64,
) -> Result<ModelRoundResult, ModelRoundError> {
    provider
        .run_round(ModelRoundRequest {
            max_output_tokens: None,
            round_id: None,
            model,
            messages,
            instructions: Some("Inspect the workspace."),
            tools: &[],
            tool_surface_digest: None,
            tool_choice: None,
            reasoning_effort: &butler_turn::btcc::ReasoningEffort::Medium,
            cancellation: CancellationToken::new(),
            attachments: &[],
            image_carrier: None,
            image_capability: None,
            image_manifests: &[],
            verified_image_payload: None,
            butler_data: None,
            usage_attribution: None,
            cache_scope: None,
            stable_provider_cache_prefix: None,
            route_context: None,
            provider_retry_attempts: Some(attempts),
            route_transport_attempt_ordinal: None,
            continuation: None,
            bounded_continuation: None,
            provider_body_admission: None,
            stream_observer: Some(observer),
            identity_observer: None,
        })
        .await
}
