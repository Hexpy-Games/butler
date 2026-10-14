use butler_models::models::*;
use butler_turn::btcc::{ModelRoundError, ProviderRequestError};
use std::{sync::Arc, time::Duration};
use url::Url;

pub(super) struct Config {
    pub endpoint: Url,
    pub shape: Option<HostedApiShape>,
    pub snapshot: Arc<ModelCatalogSnapshot>,
}
impl ProviderRequestConfigPort for Config {
    fn effective_prompt_model(&self, requested: Option<&str>) -> Result<String, ModelRoundError> {
        requested
            .map(str::to_owned)
            .ok_or_else(|| ModelRoundError::InvocationFailure {
                code: Some("offline_model_required".into()),
                message: "Replay requires an explicit model.".into(),
            })
    }
    fn sizing_snapshot(
        &self,
        _: Option<&str>,
    ) -> Result<Arc<ModelCatalogSnapshot>, ModelRoundError> {
        Ok(self.snapshot.clone())
    }
    fn resolve<'a>(&'a self, request: ProviderConfigRequest<'a>) -> ProviderConfigFuture<'a> {
        Box::pin(async move {
            let metadata = self
                .snapshot
                .resolve_model_metadata(Some(request.model_ref));
            Ok(ProviderRequestConfig {
                wire_model: metadata.model_id.clone(),
                api_shape: self.shape.or(metadata.hosted_api_shape),
                metadata,
                endpoint: self.endpoint.clone(),
                auth: ProviderAuth::ApiKey(String::from("offline-placeholder").into()),
                policy: ProviderRoundPolicy {
                    total: Duration::from_secs(10),
                    idle: None,
                    retry_base_ms: 0.0,
                },
                retry_attempts: 1.0,
                prompt_cache: ProviderPromptCachePolicy {
                    key_prefix: Some("offline".into()),
                    retention: None,
                },
                prompt_reasoning_effort: None,
            })
        })
    }
}
pub(super) struct Observer;
impl ProviderObservationSink for Observer {
    fn request(&self, _: ProviderObservation) {}
    fn response(&self, _: &str, _: &str) {}
    fn failure(&self, _: &ProviderRequestError) {}
}
pub(super) struct Clock;
impl ProviderClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        0
    }
}
pub(super) struct Metrics;
impl PromptUsageMetricSink for Metrics {
    fn append_request_diagnostic(
        &self,
        _: &serde_json::Value,
        _: Option<&str>,
    ) -> Result<(), butler_turn::btcc::ModelRoundError> {
        Ok(())
    }
    fn append(&self, _: PromptUsageMetricInput<'_>) -> Result<(), ModelRoundError> {
        Ok(())
    }
}
