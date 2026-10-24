use butler_models::models::*;
use butler_turn::btcc::{
    ModelRoundError, ModelRoundMessage, ModelRoundRequest, ProviderBodyAdmissionPort,
};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use url::Url;
pub(super) struct Config {
    pub metadata: ModelProviderMetadata,
    pub endpoint: Url,
    pub snapshot: Arc<ModelCatalogSnapshot>,
    pub codex: bool,
}

impl ProviderRequestConfigPort for Config {
    fn effective_prompt_model(&self, requested: Option<&str>) -> Result<String, ModelRoundError> {
        Ok(requested.unwrap_or(&self.metadata.model_ref).to_owned())
    }

    fn resolve<'a>(&'a self, _: ProviderConfigRequest<'a>) -> ProviderConfigFuture<'a> {
        Box::pin(async move {
            Ok(ProviderRequestConfig {
                metadata: self.metadata.clone(),
                wire_model: self.metadata.model_id.clone(),
                endpoint: self.endpoint.clone(),
                api_shape: self.metadata.hosted_api_shape,
                auth: if self.codex {
                    ProviderAuth::ChatGptPlan {
                        authorization: "Bearer test-only".to_owned().into(),
                        registration: "fixture-registration".into(),
                    }
                } else {
                    ProviderAuth::ApiKey(String::from("test-only").into())
                },
                policy: ProviderRoundPolicy {
                    total: Duration::from_secs(2),
                    idle: Some(Duration::from_secs(1)),
                    retry_base_ms: 0.0,
                },
                retry_attempts: 3.0,
                prompt_cache: ProviderPromptCachePolicy::default(),
                prompt_reasoning_effort: None,
            })
        })
    }

    fn sizing_snapshot(
        &self,
        _: Option<&str>,
    ) -> Result<Arc<ModelCatalogSnapshot>, ModelRoundError> {
        Ok(Arc::clone(&self.snapshot))
    }
}
pub(super) struct Metrics;

impl butler_models::models::PromptUsageMetricSink for Metrics {
    fn append_request_diagnostic(
        &self,
        _: &serde_json::Value,
        _: Option<&str>,
    ) -> Result<(), ModelRoundError> {
        Ok(())
    }

    fn append(
        &self,
        _: butler_models::models::PromptUsageMetricInput<'_>,
    ) -> Result<(), ModelRoundError> {
        Ok(())
    }
}

pub(super) fn request<'a>(
    model: &'a str,
    messages: &'a [ModelRoundMessage],
    effort: &'a butler_turn::btcc::ReasoningEffort,
    cancellation: CancellationToken,
    admission: Option<&'a dyn ProviderBodyAdmissionPort>,
) -> ModelRoundRequest<'a> {
    ModelRoundRequest {
        max_output_tokens: Some(64.0),
        round_id: Some("round-1"),
        model,
        messages,
        instructions: Some("Be exact."),
        tools: &[],
        tool_surface_digest: None,
        tool_choice: None,
        reasoning_effort: effort,
        cancellation,
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
        provider_retry_attempts: Some(1.0),
        route_transport_attempt_ordinal: None,
        continuation: None,
        bounded_continuation: None,
        provider_body_admission: admission,
        stream_observer: None,
        identity_observer: None,
    }
}

pub(super) struct Clock;
impl ProviderClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        1000
    }
}
pub(super) struct Observations;
impl ProviderObservationSink for Observations {
    fn request(&self, _: ProviderObservation) {}
    fn response(&self, _: &str, _: &str) {}
    fn failure(&self, _: &butler_turn::btcc::ProviderRequestError) {}
}
