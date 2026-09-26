use std::sync::Arc;

use bytes::Bytes;
use reqwest::{Client, RequestBuilder};

use crate::btcc::{ModelRoundError, ModelRoundPort, ModelRoundRequest, ModelRoundResult};

use super::super::{
    HostedApiShape, ModelCatalog, TokenEstimateInput, diagnostics, request_admission, transport,
};
use super::contracts::{
    ProviderAuth, ProviderAuthMode, ProviderClock, ProviderConfigRequest, ProviderObservation,
    ProviderObservationSink, ProviderRequestConfigPort, ProviderVisualCapabilityPort,
};
use super::result;
use super::serialize::{self, Carrier};

pub(crate) struct NativeModelProvider {
    pub(super) client: Client,
    pub(super) config: Arc<dyn ProviderRequestConfigPort>,
    pub(super) observations: Arc<dyn ProviderObservationSink>,
    pub(super) catalog: Arc<ModelCatalog>,
    pub(super) clock: Arc<dyn ProviderClock>,
    pub(super) prompt_metrics: Arc<dyn super::super::PromptUsageMetricSink>,
    visual_capability: Option<Arc<dyn ProviderVisualCapabilityPort>>,
}

impl NativeModelProvider {
    pub(crate) fn new(
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
        }
    }

    pub(crate) fn with_visual_capability(
        mut self,
        capability: Arc<dyn ProviderVisualCapabilityPort>,
    ) -> Self {
        self.visual_capability = Some(capability);
        self
    }

    async fn run(
        &self,
        request: ModelRoundRequest<'_>,
    ) -> Result<ModelRoundResult, ModelRoundError> {
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
        super::visual::validate(&request, &config.metadata)?;
        if !config.metadata.runtime_supported && config.metadata.provider_id != "openai" {
            return Err(ModelRoundError::Provider(Box::new(diagnostics::protocol(
                &config.metadata.provider_id,
                "configuration",
                "provider_model_unavailable",
            ))));
        }
        let (carrier, mode, api) = carrier(&config);
        let (mut body, continuation) =
            serialize::body_with_continuation(&request, &config, carrier)?;
        super::visual::apply(&mut body, &request, carrier).await?;
        let serialized = crate::json::stringify(&body).map_err(|error| {
            ModelRoundError::Provider(Box::new(diagnostics::network(
                &config.metadata.provider_id,
                api,
                error.to_string(),
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
            request_admission::PrepareAdmissionInput {
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
            stream_observer: request.stream_observer,
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
}

pub(super) fn safe_endpoint(endpoint: &url::Url) -> String {
    let mut endpoint = endpoint.clone();
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    endpoint.to_string()
}

impl ModelRoundPort for NativeModelProvider {
    fn context_sizing<'a>(
        &'a self,
        request: crate::btcc::ContextSizingRequest<'a>,
    ) -> Result<Option<crate::btcc::ContextSizing<'a>>, ModelRoundError> {
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
        let fixed_json = crate::json::stringify(&fixed_value).map_err(|error| {
            ModelRoundError::Integrity(crate::btcc::BtccError::new(
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
                ModelRoundError::Integrity(crate::btcc::BtccError::new(
                    "context_tokenization_failed",
                    error.to_string(),
                ))
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
        Ok(Some(crate::btcc::ContextSizing {
            max_output_tokens: metadata.max_output_tokens,
            max_message_bytes,
            measure: Box::new(move |messages| {
                let value = if model.starts_with("openai/") {
                    serde_json::Value::Array(serialize::bounded_items(messages))
                } else {
                    serde_json::to_value(messages).map_err(|_| {
                        crate::btcc::BtccError::new(
                            "context_serialization_failed",
                            "Context serialization failed.",
                        )
                    })?
                };
                let bytes = crate::json::stringify(&value).map_err(|_| {
                    crate::btcc::BtccError::new(
                        "context_serialization_failed",
                        "Context serialization failed.",
                    )
                })?;
                let tokens = catalog
                    .estimate_tokens(&snapshot, TokenEstimateInput::Text(&bytes), Some(&model))
                    .map_err(|_| {
                        crate::btcc::BtccError::new(
                            "context_tokenization_failed",
                            "Context tokenization failed.",
                        )
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
        crate::json::stringify(&value)
            .map(|value| Some(value.len()))
            .map_err(|error| {
                ModelRoundError::Provider(Box::new(diagnostics::network(
                    "openai",
                    "serialization",
                    error.to_string(),
                )))
            })
    }

    fn stateless_message_bytes(
        &self,
        messages: &[crate::btcc::ModelRoundMessage],
        _butler_data: Option<&str>,
    ) -> Result<Option<usize>, ModelRoundError> {
        crate::json::stringify(&serde_json::Value::Array(serialize::bounded_items(
            messages,
        )))
        .map(|value| Some(value.len()))
        .map_err(|error| {
            ModelRoundError::Provider(Box::new(diagnostics::network(
                "openai",
                "serialization",
                error.to_string(),
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
        Box::pin(self.run(request))
    }
}

pub(super) fn carrier(
    config: &super::contracts::ProviderRequestConfig,
) -> (Carrier, transport::ResponseMode, &'static str) {
    if config.metadata.provider_id == "openai" {
        return if matches!(
            config.auth.mode(),
            ProviderAuthMode::CodexOauth | ProviderAuthMode::CodexSubscription
        ) {
            (
                Carrier::Responses,
                transport::ResponseMode::CodexSse,
                "codex_responses",
            )
        } else {
            (
                Carrier::Responses,
                transport::ResponseMode::Json {
                    tolerate_invalid: false,
                },
                "responses",
            )
        };
    }
    match (config.metadata.provider_id.as_str(), config.api_shape) {
        ("anthropic", _) | ("opencode-go", Some(HostedApiShape::AnthropicMessages)) => (
            Carrier::Anthropic,
            transport::ResponseMode::Json {
                tolerate_invalid: true,
            },
            "messages",
        ),
        ("google", _) => (
            Carrier::Gemini,
            transport::ResponseMode::Json {
                tolerate_invalid: true,
            },
            "generate_content",
        ),
        ("local", _) => (
            Carrier::Chat { stream: false },
            transport::ResponseMode::Json {
                tolerate_invalid: true,
            },
            "chat_completions",
        ),
        (_, Some(HostedApiShape::OpenaiResponses)) => (
            Carrier::Responses,
            transport::ResponseMode::Json {
                tolerate_invalid: false,
            },
            "responses",
        ),
        _ => (
            Carrier::Chat { stream: true },
            transport::ResponseMode::HostedChatSse,
            "chat_completions",
        ),
    }
}

pub(super) fn authorize(
    request: RequestBuilder,
    auth: &ProviderAuth,
    provider: &str,
    carrier: Carrier,
) -> RequestBuilder {
    match auth {
        ProviderAuth::None => request,
        ProviderAuth::ApiKey(value) if matches!(carrier, Carrier::Anthropic) => request
            .header("x-api-key", value)
            .header("anthropic-version", "2023-06-01"),
        ProviderAuth::ApiKey(value) if provider == "google" => {
            request.header("x-goog-api-key", value)
        }
        ProviderAuth::ApiKey(value) => request.bearer_auth(value),
        ProviderAuth::Codex {
            authorization,
            account_id,
            user_agent,
            originator,
            ..
        } => request
            .header("authorization", authorization)
            .header("accept", "text/event-stream")
            .header("openai-beta", "responses=experimental")
            .header("user-agent", user_agent)
            .header("chatgpt-account-id", account_id)
            .header("originator", originator),
    }
}
