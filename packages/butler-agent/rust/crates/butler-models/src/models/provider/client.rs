mod admission;
mod dispatch;
use dispatch::{DispatchedRound, RoundDispatch};

use std::sync::Arc;

use bytes::Bytes;
use reqwest::Client;

use butler_turn::btcc::{ModelRoundError, ModelRoundPort, ModelRoundRequest, ModelRoundResult};

use super::super::{ModelCatalog, TokenEstimateInput, diagnostics, request_admission, transport};
use super::contracts::{
    ProviderAuth, ProviderAuthMode, ProviderClock, ProviderConfigRequest, ProviderObservation,
    ProviderObservationSink, ProviderRequestConfigPort, ProviderVisualCapabilityPort,
};
use super::local_stream::LocalStreaming;
use super::result;
pub(super) use super::route::{authorize, carrier};
use super::serialize;

type RoundFuture<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<ModelRoundResult, ModelRoundError>> + Send + 'a>,
>;

struct PreparedResponse {
    carrier: serialize::Carrier,
    continuation: Option<super::continuation::LegacyProjection>,
    identity: Option<serde_json::Value>,
    prefix: serde_json::Value,
}

pub struct ModelProvider {
    pub(super) client: Client,
    pub(super) config: Arc<dyn ProviderRequestConfigPort>,
    pub(super) observations: Arc<dyn ProviderObservationSink>,
    pub(super) catalog: Arc<ModelCatalog>,
    pub(super) clock: Arc<dyn ProviderClock>,
    pub(super) prompt_metrics: Arc<dyn super::super::PromptUsageMetricSink>,
    pub(super) prefix_history: Arc<super::prefix_diagnostics::History>,
    pub(super) keepalive: Arc<super::keepalive::Keepalive>,
    sizing_cache: Arc<super::sizing::Cache>,
    visual_capability: Option<Arc<dyn ProviderVisualCapabilityPort>>,
    local_streaming: LocalStreaming,
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
            keepalive: Arc::new(super::keepalive::Keepalive::default()),
            sizing_cache: Arc::new(super::sizing::Cache::default()),
            visual_capability: None,
            local_streaming: LocalStreaming::default(),
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
    ) -> Result<ModelRoundResult, ModelRoundError> {
        self.keepalive.stop_scope(request.cache_scope);
        let config = Arc::new(self.round_config(&request).await?);
        let (carrier, mode, api) =
            self.local_streaming
                .carrier(&config, carrier(&config), local_stream);
        let (mut body, continuation) =
            serialize::body_with_continuation(&request, &config, carrier)?;
        super::visual::apply(&mut body, &request, carrier).await?;
        let dispatch::EncodedRequest {
            prefix,
            serialized,
            provider_cache_identity,
        } = self.encode_request(&request, &config, &body, api)?;
        let DispatchedRound {
            response,
            prefix,
            stream_refused,
        } = self
            .dispatch_round(
                &request,
                &config,
                RoundDispatch {
                    body,
                    carrier,
                    mode,
                    api,
                    serialized,
                    prefix,
                },
            )
            .await?;
        let response = match response {
            Ok(value) => value,
            Err(ModelRoundError::Provider(_error)) if local_stream && stream_refused => {
                if let Some(prefix) = &prefix {
                    super::round_usage::record(self, &request, None, &config, prefix)?;
                }
                return self
                    .run_without_streaming(request, config.endpoint.clone())
                    .await;
            }
            Err(ModelRoundError::Provider(mut error)) => {
                if let Some(prefix) = &prefix {
                    super::round_usage::record(self, &request, None, &config, prefix)?;
                }
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
            Err(error) => {
                if let Some(prefix) = &prefix {
                    super::round_usage::record(self, &request, None, &config, prefix)?;
                }
                return Err(error);
            }
        };
        self.complete(
            &request,
            &config,
            response,
            PreparedResponse {
                carrier,
                continuation,
                identity: provider_cache_identity,
                prefix: prefix.unwrap_or(serde_json::Value::Null),
            },
        )
    }

    fn complete(
        &self,
        request: &ModelRoundRequest<'_>,
        config: &super::ProviderRequestConfig,
        response: serde_json::Value,
        mut prepared: PreparedResponse,
    ) -> Result<ModelRoundResult, ModelRoundError> {
        let round_index = request
            .usage_attribution
            .and_then(|value| value.round_index)
            .unwrap_or(0);
        super::prefix_diagnostics::reported_usage(&mut prepared.prefix, &response);
        let mut result = result::decode(
            response,
            &config.metadata.provider_id,
            &config.metadata.model_ref,
            prepared.carrier,
            round_index,
            request,
            prepared.continuation,
        );
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
    ) -> reqwest::RequestBuilder {
        let mut http = self
            .client
            .post(config.endpoint.clone())
            .header("content-type", "application/json");
        if matches!(mode, transport::ResponseMode::HostedChatSse) {
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
    fn worker_wait(&self, session: &str, turn: &str, waiting: bool) {
        if waiting {
            self.keepalive.start(session, turn);
        } else {
            self.keepalive.stop_turn(turn);
        }
    }
    fn stop_cache_wait(&self, turn: &str) {
        self.keepalive.stop_turn(turn);
    }
    fn close_cache_waits(&self) {
        self.keepalive.close();
    }

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
        Box::pin(self.run(request, true))
    }
}
