mod admission;
mod dispatch;
mod response;

use std::sync::Arc;

use butler_log::http::Client;
use bytes::Bytes;

use butler_turn::btcc::{ModelRoundError, ModelRoundPort, ModelRoundRequest, ModelRoundResult};

use super::super::{ModelCatalog, TokenEstimateInput, diagnostics, request_admission, transport};
use super::contracts::{
    ProviderAuth, ProviderAuthMode, ProviderClock, ProviderConfigRequest, ProviderObservation,
    ProviderObservationSink, ProviderRequestConfigPort, ProviderVisualCapabilityPort,
};
use super::local_stream::{self, LocalStreaming, StreamWatch};
use super::result;
pub(super) use super::route::{authorize, carrier};
use super::serialize;

type RoundFuture<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<ModelRoundResult, ModelRoundError>> + Send + 'a>,
>;

struct PreparedResponse {
    body: Option<serde_json::Value>,
    capability_revision: Option<String>,
    carrier: serialize::Carrier,
    continuation: Option<super::continuation::LegacyProjection>,
    identity: Option<serde_json::Value>,
    prefix: serde_json::Value,
    thinking_binding: Option<super::anthropic_thinking::Binding>,
    summary: bool,
}

pub struct ModelProvider {
    pub(super) client: Client,
    pub(super) config: Arc<dyn ProviderRequestConfigPort>,
    pub(super) observations: Arc<dyn ProviderObservationSink>,
    pub(super) catalog: Arc<ModelCatalog>,
    pub(super) clock: Arc<dyn ProviderClock>,
    pub(super) prompt_metrics: Arc<dyn super::super::PromptUsageMetricSink>,
    pub(super) prefix_history: Arc<super::prefix_diagnostics::History>,
    sizing_cache: Arc<super::sizing::Cache>,
    visual_capability: Option<Arc<dyn ProviderVisualCapabilityPort>>,
    local_streaming: LocalStreaming,
    stream_usage: super::stream_usage::StreamUsage,
    summaries: super::thinking_summary::Summaries,
    pub(super) quota: Option<Arc<dyn crate::models::ProviderQuotaSink>>,
}

impl ModelProvider {
    pub fn new(
        client: Client,
        config: Arc<dyn ProviderRequestConfigPort>,
        observations: Arc<dyn ProviderObservationSink>,
        catalog: Arc<ModelCatalog>,
        clock: Arc<dyn ProviderClock>,
        prompt_metrics: Arc<dyn super::super::PromptUsageMetricSink>,
    ) -> Self {
        Self {
            client,
            config,
            observations,
            catalog,
            clock,
            prompt_metrics,
            prefix_history: Arc::new(super::prefix_diagnostics::History::default()),
            sizing_cache: Arc::new(super::sizing::Cache::default()),
            visual_capability: None,
            local_streaming: LocalStreaming::default(),
            stream_usage: super::stream_usage::StreamUsage::default(),
            summaries: Default::default(),
            quota: None,
        }
    }

    /// Reports subscription quota parsed from successful responses to `sink`.
    pub fn with_quota_sink(mut self, sink: Arc<dyn crate::models::ProviderQuotaSink>) -> Self {
        self.quota = Some(sink);
        self
    }

    pub fn with_visual_capability(
        mut self,
        capability: Arc<dyn ProviderVisualCapabilityPort>,
    ) -> Self {
        self.visual_capability = Some(capability);
        self
    }

    /// One model round. `local_stream` lets a local round stream; it is false
    /// only for the retry of a round the local server refused to stream.
    async fn run(
        &self,
        request: ModelRoundRequest<'_>,
        local_stream: bool,
        include_usage: bool,
        retry: super::chatgpt_plan::retry::Retry,
        include_summary: bool,
    ) -> Result<ModelRoundResult, ModelRoundError> {
        let config = self.round_config(&request, retry.authorization()).await?;
        let (carrier, mode, api) =
            self.local_streaming
                .carrier(&config, carrier(&config), local_stream);
        let include_usage = include_usage && self.stream_usage.supported(&config);
        let prepared = self
            .prepare_http(
                &request,
                &config,
                (carrier, mode, api),
                include_usage,
                include_summary,
            )
            .await?;
        let watch = StreamWatch::new(request.stream_observer)
            .with_summary(prepared.summary, request.round_id);
        let sent = self
            .dispatch(&request, &config, (carrier, mode, api), &watch, prepared)
            .await;
        self.finish_round(
            request,
            config,
            sent,
            watch,
            (local_stream, include_usage, include_summary),
            retry,
        )
        .await
    }

    fn record_failed_usage(
        &self,
        request: &ModelRoundRequest<'_>,
        config: &super::ProviderRequestConfig,
        prefix: Option<&serde_json::Value>,
    ) -> Result<(), ModelRoundError> {
        if let Some(prefix) = prefix {
            super::round_usage::record(self, request, None, config, prefix)?;
        }
        Ok(())
    }

    fn complete(
        &self,
        request: &ModelRoundRequest<'_>,
        config: &super::ProviderRequestConfig,
        response: serde_json::Value,
        mut prepared: PreparedResponse,
    ) -> Result<ModelRoundResult, ModelRoundError> {
        super::prefix_diagnostics::reported_usage(&mut prepared.prefix, &response);
        let mut result = result::decode(
            response,
            &config.metadata.provider_id,
            &config.metadata.model_ref,
            prepared.carrier,
            round_index(request),
            request,
            prepared.continuation,
        );
        if prepared.summary {
            result.reasoning_summary =
                super::thinking_summary::extract(result.raw.as_ref(), prepared.carrier);
        }
        if let Some(binding) = &prepared.thinking_binding {
            super::anthropic_thinking::bind(&mut result, binding);
        }
        if result.usage.is_none() && matches!(prepared.carrier, serialize::Carrier::Chat { .. }) {
            result.usage = super::stream_usage::estimate(&result, &prepared.prefix, request.model);
        }
        if let Some(identity) = prepared.identity {
            let continuation = result
                .continuation
                .get_or_insert_with(|| serde_json::json!({"provider":"openai"}));
            continuation
                .as_object_mut()
                .ok_or_else(|| {
                    ModelRoundError::StablePrefix("stable_provider_prefix_contract_invalid".into())
                })?
                .insert("providerRouteIdentity".into(), identity);
        }
        if let Some(identity) = &result.provider_identity
            && let Some(observer) = request.identity_observer
        {
            observer.identity(identity);
        }
        super::round_usage::record(
            self,
            request,
            result.usage.as_ref(),
            config,
            &prepared.prefix,
        )?;
        if let Some(error) = result.raw.as_ref().and_then(|raw| {
            result::stop::error(
                &result.stop,
                raw,
                prepared.carrier,
                &config.metadata.provider_id,
                carrier(config).2,
                false,
            )
        }) {
            self.observations.failure(&error);
            return Err(ModelRoundError::Provider(error));
        }
        self.observations
            .response(&config.metadata.provider_id, &config.metadata.model_ref);
        Ok(result)
    }

    /// The HTTP request of a round: its endpoint, body and auth headers.
    fn round_request(
        &self,
        config: &super::contracts::ProviderRequestConfig,
        mode: transport::ResponseMode,
        carrier: super::serialize::Carrier,
        body: Bytes,
    ) -> butler_log::http::RequestBuilder {
        let mut http = self
            .client
            .post(super::route::stream_endpoint(&config.endpoint, mode))
            .header("content-type", "application/json");
        if matches!(
            mode,
            transport::ResponseMode::HostedChatSse(_)
                | transport::ResponseMode::ResponsesSse
                | transport::ResponseMode::AnthropicSse
                | transport::ResponseMode::GeminiSse { .. }
        ) {
            http = http.header("accept", "text/event-stream");
        }
        authorize(
            http.body(body),
            &config.auth,
            &config.metadata.provider_id,
            carrier,
        )
    }

    /// The provider request configuration of a round, checked for its
    /// images and for a runtime-supported model.
    async fn round_config(
        &self,
        request: &ModelRoundRequest<'_>,
        rejected_authorization: Option<&str>,
    ) -> Result<super::contracts::ProviderRequestConfig, ModelRoundError> {
        if request.cancellation.is_cancelled() {
            return Err(ModelRoundError::Cancelled);
        }
        let mut config = self
            .config
            .resolve(ProviderConfigRequest {
                model_ref: request.model,
                rejected_authorization,
                butler_data: None,
            })
            .await
            .map_err(ModelRoundError::Provider)?;
        if !request.image_manifests.is_empty() {
            super::visual_capability::refresh_current_zai_capability(
                &mut config.metadata,
                self.visual_capability.as_deref(),
                &request.cancellation,
            )
            .await?;
        }
        super::visual::validate(request, &config.metadata)?;
        if !config.metadata.runtime_supported && config.metadata.provider_id != "openai" {
            return Err(ModelRoundError::Provider(Box::new(diagnostics::protocol(
                &config.metadata.provider_id,
                "configuration",
                "provider_model_unavailable",
            ))));
        }
        Ok(config)
    }

    /// Repeats a round the local server refused to stream, without
    /// streaming; when that works the endpoint is not asked to stream again.
    fn run_without_streaming<'a>(
        &'a self,
        request: ModelRoundRequest<'a>,
        endpoint: url::Url,
    ) -> RoundFuture<'a> {
        Box::pin(async move {
            let result = self
                .run(request, false, true, Default::default(), true)
                .await;
            if result.is_ok() {
                self.local_streaming.refuse(&endpoint);
            }
            result
        })
    }
}

/// The round's index within its turn, as decoded call ids name it.
fn round_index(request: &ModelRoundRequest<'_>) -> u32 {
    request
        .usage_attribution
        .and_then(|value| value.round_index)
        .unwrap_or(0)
}

pub(super) fn safe_endpoint(endpoint: &url::Url) -> String {
    let mut endpoint = endpoint.clone();
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    endpoint.to_string()
}

impl ModelRoundPort for ModelProvider {
    fn context_sizing<'a>(
        &'a self,
        request: butler_turn::btcc::ContextSizingRequest<'a>,
    ) -> Result<Option<butler_turn::btcc::ContextSizing<'a>>, ModelRoundError> {
        let snapshot = self.config.sizing_snapshot(request.butler_data)?;
        let Some(metadata) = snapshot.find_model_metadata(Some(request.model)) else {
            return Ok(None);
        };
        let Some(context) = metadata.context_window_tokens.filter(|value| *value > 0.0) else {
            return Ok(None);
        };
        let output = request
            .max_output_tokens
            .or(metadata.max_output_tokens)
            .unwrap_or(0.0);
        let fixed_value = serde_json::json!({"instructions":request.instructions,"tools":request.tools,"tool_choice":"auto","model":request.model});
        let fixed_json = butler_core::json::stringify(&fixed_value).map_err(|error| {
            ModelRoundError::Integrity(butler_turn::btcc::BtccError::relayed(
                "context_serialization_failed",
                error.to_string(),
            ))
        })?;
        let fixed = self
            .catalog
            .estimate_tokens(
                &snapshot,
                TokenEstimateInput::Text(&fixed_json),
                Some(request.model),
            )
            .map_err(|error| {
                ModelRoundError::Integrity(
                    butler_turn::btcc::BtccError::relayed(
                        "context_tokenization_failed",
                        error.to_string(),
                    )
                    .with_source(error),
                )
            })?
            .tokens
            + request
                .attachments
                .iter()
                .filter(|value| {
                    value.get("kind").and_then(serde_json::Value::as_str) == Some("image")
                })
                .count() as f64
                * 8192.0;
        let max_message_bytes = ((context - output - fixed) * 2.0).max(1.0);
        let catalog = Arc::clone(&self.catalog);
        let model = request.model.to_owned();
        let cache = Arc::clone(&self.sizing_cache);
        Ok(Some(butler_turn::btcc::ContextSizing {
            max_output_tokens: metadata.max_output_tokens,
            max_message_bytes,
            measure: Box::new(move |messages| {
                super::sizing::measure(&catalog, &snapshot, &model, messages, &cache)
            }),
        }))
    }

    fn initial_request_bytes(
        &self,
        prompt: &str,
        instructions: &str,
        _butler_data: Option<&str>,
    ) -> Result<Option<usize>, ModelRoundError> {
        let input =
            serde_json::json!([{"role":"user","content":[{"type":"input_text","text":prompt}]}]);
        let value = serde_json::json!({"instructions":instructions,"input":input});
        butler_core::json::stringify(&value)
            .map(|value| Some(value.len()))
            .map_err(|error| {
                ModelRoundError::Provider(Box::new(diagnostics::network(
                    "openai",
                    "serialization",
                    &error.to_string(),
                )))
            })
    }

    fn stateless_message_bytes(
        &self,
        messages: &[butler_turn::btcc::ModelRoundMessage],
        _butler_data: Option<&str>,
    ) -> Result<Option<usize>, ModelRoundError> {
        butler_core::json::stringify(&serde_json::Value::Array(serialize::bounded_items(
            messages,
        )))
        .map(|value| Some(value.len()))
        .map_err(|error| {
            ModelRoundError::Provider(Box::new(diagnostics::network(
                "openai",
                "serialization",
                &error.to_string(),
            )))
        })
    }

    fn run_round<'a>(
        &'a self,
        request: ModelRoundRequest<'a>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<ModelRoundResult, ModelRoundError>> + Send + 'a,
        >,
    > {
        Box::pin(self.run(request, true, true, Default::default(), true))
    }
}
