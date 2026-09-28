use std::sync::Arc;

use bytes::Bytes;
use reqwest::Client;

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

pub struct ModelProvider {
    pub(super) client: Client,
    pub(super) config: Arc<dyn ProviderRequestConfigPort>,
    pub(super) observations: Arc<dyn ProviderObservationSink>,
    pub(super) catalog: Arc<ModelCatalog>,
    pub(super) clock: Arc<dyn ProviderClock>,
    pub(super) prompt_metrics: Arc<dyn super::super::PromptUsageMetricSink>,
    visual_capability: Option<Arc<dyn ProviderVisualCapabilityPort>>,
    local_streaming: LocalStreaming,
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
            visual_capability: None,
            local_streaming: LocalStreaming::default(),
        }
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
    ) -> Result<ModelRoundResult, ModelRoundError> {
        let config = self.round_config(&request).await?;
        let (carrier, mode, api) =
            self.local_streaming
                .carrier(&config, carrier(&config), local_stream);
        let (mut body, continuation) =
            serialize::body_with_continuation(&request, &config, carrier)?;
        super::visual::apply(&mut body, &request, carrier).await?;
        let serialized = butler_core::json::stringify(&body).map_err(|error| {
            ModelRoundError::Provider(Box::new(diagnostics::network(
                &config.metadata.provider_id,
                api,
                &error.to_string(),
            )))
        })?;
        let provider_cache_identity =
            serialize::provider_cache_identity(&body, &serialized, &request, &config)?;
        let serialized = Bytes::from(serialized);
        let codex_output = matches!(
            config.auth.mode(),
            ProviderAuthMode::CodexOauth | ProviderAuthMode::CodexSubscription
        )
        .then_some(request.max_output_tokens)
        .flatten();
        let physical_admission = request_admission::PreparedRequestAdmission::new(
            &request_admission::PrepareAdmissionInput {
                catalog: &self.catalog,
                config: self.config.as_ref(),
                provider: &config.metadata.provider_id,
                model_ref: &config.metadata.model_ref,
                butler_data: None,
                requested_output_tokens: serialize::requested_output_tokens(
                    &body,
                    carrier,
                    codex_output,
                ),
                context_window_tokens: (config.metadata.provider_id == "local")
                    .then_some(config.metadata.context_window_tokens)
                    .flatten(),
                max_output_tokens: (config.metadata.provider_id == "local")
                    .then_some(config.metadata.max_output_tokens)
                    .flatten(),
                body: &body,
                serialized: serialized.clone(),
            },
        )?;
        drop(body);
        let serialized_bytes = serialized.len();
        let watch = StreamWatch::new(request.stream_observer);
        let observe_request = || {
            self.observations.request(ProviderObservation {
                request_bytes: serialized_bytes,
            });
        };
        let mut http = self
            .client
            .post(config.endpoint.clone())
            .header("content-type", "application/json");
        if matches!(mode, transport::ResponseMode::HostedChatSse) {
            http = http.header("accept", "text/event-stream");
        }
        let http = authorize(
            http.body(serialized),
            &config.auth,
            &config.metadata.provider_id,
            carrier,
        );
        let response = transport::execute(transport::RequestExecution {
            request: http,
            provider: &config.metadata.provider_id,
            api,
            policy: config.policy,
            external: request.cancellation.clone(),
            mode,
            stream_observer: Some(&watch),
            attempts: request
                .provider_retry_attempts
                .unwrap_or(config.retry_attempts),
            admission: request.provider_body_admission,
            physical_admission: Some(&physical_admission),
            serialized_bytes,
            guard_start: if config.metadata.provider_id == "openai" {
                transport::GuardStart::AfterAdmission
            } else {
                transport::GuardStart::BeforeAdmission
            },
            request_observer: &observe_request,
            clock: self.clock.as_ref(),
        })
        .await;
        let response = match response {
            Ok(value) => value,
            Err(ModelRoundError::Provider(error))
                if local_stream && local_stream::falls_back(carrier, &error, &watch) =>
            {
                return self
                    .run_without_streaming(request, config.endpoint.clone())
                    .await;
            }
            Err(ModelRoundError::Provider(mut error)) => {
                if config.metadata.provider_id == "local"
                    && let ProviderAuth::ApiKey(secret) = &config.auth
                {
                    super::redact::redact_local_error(&mut error, secret);
                }
                error.endpoint = Some(safe_endpoint(&config.endpoint));
                error.model = Some(config.wire_model.clone());
                self.observations.failure(&error);
                return Err(ModelRoundError::Provider(error));
            }
            Err(error) => return Err(error),
        };
        let round_index = request
            .usage_attribution
            .and_then(|value| value.round_index)
            .unwrap_or(0);
        let mut result = result::decode(
            response,
            &config.metadata.provider_id,
            &config.metadata.model_ref,
            carrier,
            round_index,
            &request,
            continuation,
        );
        if let Some(identity) = provider_cache_identity {
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
        if let Some(usage) = &result.usage {
            let attribution =
                request
                    .usage_attribution
                    .map(|value| crate::models::PromptUsageAttribution {
                        turn_id: Some(&value.turn_id),
                        phase: Some(&value.phase),
                        round_index: value.round_index.map(f64::from),
                        reasoning_effort: None,
                        requested_output_tokens: request.max_output_tokens,
                        budget_state: None,
                        budget_state_source: None,
                        prompt_sections: None,
                    });
            self.prompt_metrics
                .append(crate::models::PromptUsageMetricInput {
                    model: usage
                        .get("model")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(request.model),
                    scope: request.cache_scope.unwrap_or("btcc-agent-loop"),
                    prompt_tokens: usage
                        .get("promptTokens")
                        .and_then(serde_json::Value::as_f64),
                    cached_tokens: usage
                        .get("cachedTokens")
                        .and_then(serde_json::Value::as_f64)
                        .unwrap_or(0.0),
                    total_tokens: usage.get("totalTokens").and_then(serde_json::Value::as_f64),
                    cache_write_tokens: None,
                    prompt_cache_key: None,
                    prompt_cache_retention: None,
                    butler_data: request.butler_data,
                    usage_attribution: attribution.as_ref(),
                })?;
        }
        self.observations
            .response(&config.metadata.provider_id, &config.metadata.model_ref);
        Ok(result)
    }

    /// The provider request configuration of a round, checked for its
    /// images and for a runtime-supported model.
    async fn round_config(
        &self,
        request: &ModelRoundRequest<'_>,
    ) -> Result<super::contracts::ProviderRequestConfig, ModelRoundError> {
        if request.cancellation.is_cancelled() {
            return Err(ModelRoundError::Cancelled);
        }
        let mut config = self
            .config
            .resolve(ProviderConfigRequest {
                model_ref: request.model,
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
            let result = self.run(request, false).await;
            if result.is_ok() {
                self.local_streaming.refuse(&endpoint);
            }
            result
        })
    }
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
        Ok(Some(butler_turn::btcc::ContextSizing {
            max_output_tokens: metadata.max_output_tokens,
            max_message_bytes,
            measure: Box::new(move |messages| {
                let value = if model.starts_with("openai/") {
                    serde_json::Value::Array(serialize::bounded_items(messages))
                } else {
                    serde_json::to_value(messages).map_err(|source| {
                        butler_turn::btcc::BtccError::relayed(
                            "context_serialization_failed",
                            "Context serialization failed.",
                        )
                        .with_source(source)
                    })?
                };
                let bytes = butler_core::json::stringify(&value).map_err(|source| {
                    butler_turn::btcc::BtccError::relayed(
                        "context_serialization_failed",
                        "Context serialization failed.",
                    )
                    .with_source(source)
                })?;
                let tokens = catalog
                    .estimate_tokens(&snapshot, TokenEstimateInput::Text(&bytes), Some(&model))
                    .map_err(|source| {
                        butler_turn::btcc::BtccError::relayed(
                            "context_tokenization_failed",
                            "Context tokenization failed.",
                        )
                        .with_source(source)
                    })?
                    .tokens;
                Ok(tokens * 2.0)
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
        Box::pin(self.run(request, true))
    }
}
