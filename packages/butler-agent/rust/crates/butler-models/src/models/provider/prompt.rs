mod attachments;
mod result;
mod serialize;

use bytes::Bytes;

use crate::models::{
    PromptUsageMetricInput, ProviderConfigRequest, ProviderPromptFuture, ProviderPromptLifecycle,
    ProviderPromptPort, ProviderPromptRequest, ProviderPromptResult,
};
use butler_turn::btcc::ModelRoundError;

use super::{ModelProvider, ProviderObservation, serialize::Carrier};

impl ProviderPromptPort for ModelProvider {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        Box::pin(run(self, request, lifecycle))
    }
}

async fn run(
    provider: &ModelProvider,
    request: ProviderPromptRequest<'_>,
    lifecycle: ProviderPromptLifecycle<'_>,
) -> Result<ProviderPromptResult, ModelRoundError> {
    cancelled(&request)?;
    let effective_model = effective_model(provider, request.model).await?;
    if let Some(intent) = lifecycle.invocation_intent {
        intent.invoked().await?;
    }
    cancelled(&request)?;
    if let Some(entry) = lifecycle.adapter_entry {
        entry.entered()?;
    }
    let config = provider
        .config
        .resolve(ProviderConfigRequest {
            model_ref: &effective_model,
            butler_data: None,
        })
        .await
        .map_err(ModelRoundError::Provider)?;
    let (carrier, mode, api) = crate::models::provider::client::carrier(&config);
    let serialize::PromptWire {
        body,
        cache_retention,
    } = serialize::body(&request, &config, carrier)?;
    let serialized = butler_core::json::stringify(&body).map_err(|error| {
        ModelRoundError::InvocationFailure {
            code: Some("prompt_serialization_failed".into()),
            message: error.to_string(),
        }
    })?;
    let serialized = Bytes::from(serialized);
    let prefix = provider.prefix_history.prepare(&body, &config)?;
    let physical = admission(
        provider,
        &request,
        &config,
        &body,
        serialized.clone(),
        carrier,
    )?;
    let mut http = provider
        .client
        .post(config.endpoint.clone())
        .header("content-type", "application/json");
    if matches!(mode, crate::models::transport::ResponseMode::HostedChatSse) {
        http = http.header("accept", "text/event-stream");
    }
    let http = crate::models::provider::client::authorize(
        http.body(serialized.clone()),
        &config.auth,
        &config.metadata.provider_id,
        carrier,
    );
    let http = super::route::cache_affinity(http, &config.auth, body);
    let trace = super::request_trace::RequestTrace::new(
        provider,
        prefix,
        request.cache_scope,
        request.usage_attribution.and_then(|a| a.phase),
        request.usage_attribution.and_then(|a| a.round_index),
        "background",
        request.butler_data,
    )
    .await?;
    let request_bytes = serialized.len();
    let observe = || {
        provider
            .observations
            .request(ProviderObservation { request_bytes });
    };
    let attempts = retry_attempts(request.provider_retry_attempts, config.retry_attempts);
    let response = crate::models::transport::execute(crate::models::transport::RequestExecution {
        request: http,
        provider: &config.metadata.provider_id,
        api,
        policy: config.policy,
        external: request.cancellation.clone(),
        mode,
        stream_observer: request.stream_observer,
        attempts,
        admission: None,
        physical_admission: Some(&physical),
        serialized_bytes: serialized.len(),
        guard_start: if config.metadata.provider_id == "openai" {
            crate::models::transport::GuardStart::AfterAdmission
        } else {
            crate::models::transport::GuardStart::BeforeAdmission
        },
        request_observer: &observe,
        trace: &trace,
        clock: provider.clock.as_ref(),
        quota: provider.quota.as_deref(),
    })
    .await;
    let observation = UsageObservation {
        carrier,
        cache_retention,
        prefix: trace.latest().unwrap_or(serde_json::Value::Null),
    };
    if response.is_err() && !observation.prefix.is_null() {
        observe_usage(provider, &request, &config, &observation, None)?;
    }
    let response = match response {
        Ok(value) => value,
        Err(ModelRoundError::Provider(mut error)) => {
            error.endpoint = Some(crate::models::provider::client::safe_endpoint(
                &config.endpoint,
            ));
            error.model = Some(config.wire_model.clone());
            provider.observations.failure(&error);
            return Err(ModelRoundError::Provider(error));
        }
        Err(error) => return Err(error),
    };
    complete(provider, &request, &config, observation, &response)
}

fn admission<'a>(
    provider: &'a ModelProvider,
    request: &ProviderPromptRequest<'_>,
    config: &'a super::ProviderRequestConfig,
    body: &serde_json::Value,
    serialized: Bytes,
    carrier: Carrier,
) -> Result<crate::models::request_admission::PreparedRequestAdmission<'a>, ModelRoundError> {
    crate::models::request_admission::PreparedRequestAdmission::new(
        &crate::models::request_admission::PrepareAdmissionInput {
            catalog: &provider.catalog,
            config: provider.config.as_ref(),
            provider: &config.metadata.provider_id,
            model_ref: &config.metadata.model_ref,
            butler_data: None,
            requested_output_tokens: super::serialize::requested_output_tokens(
                body,
                carrier,
                matches!(
                    config.auth.mode(),
                    super::ProviderAuthMode::CodexOauth
                        | super::ProviderAuthMode::CodexSubscription
                )
                .then(|| {
                    request
                        .usage_attribution
                        .and_then(|value| value.requested_output_tokens)
                })
                .flatten(),
            ),
            context_window_tokens: (config.metadata.provider_id == "local")
                .then_some(config.metadata.context_window_tokens)
                .flatten(),
            max_output_tokens: (config.metadata.provider_id == "local")
                .then_some(config.metadata.max_output_tokens)
                .flatten(),
            body,
            serialized,
        },
    )
}

fn complete(
    provider: &ModelProvider,
    request: &ProviderPromptRequest<'_>,
    config: &super::ProviderRequestConfig,
    mut observation: UsageObservation,
    response: &serde_json::Value,
) -> Result<ProviderPromptResult, ModelRoundError> {
    let carrier = observation.carrier;
    let reported_model = if config.metadata.provider_id == "openai" {
        config.wire_model.as_str()
    } else {
        config.metadata.model_ref.as_str()
    };
    let decoded = result::decode(response, reported_model, carrier);
    super::prefix_diagnostics::reported_usage(&mut observation.prefix, response);
    observe_usage(provider, request, config, &observation, Some(&decoded))?;
    let (_, _, api) = super::client::carrier(config);
    let text = decoded.text.ok_or_else(|| {
        ModelRoundError::Provider(Box::new(crate::models::diagnostics::empty(
            &config.metadata.provider_id,
            api,
        )))
    })?;
    provider
        .observations
        .response(&config.metadata.provider_id, &config.metadata.model_ref);
    Ok(ProviderPromptResult {
        text,
        model: reported_model.to_owned(),
        usage: (config.metadata.provider_id == "openai")
            .then_some(decoded.usage)
            .flatten(),
    })
}

/// The request's own retry count (truncated, at least one), else the configured one.
fn retry_attempts(requested: Option<f64>, configured: f64) -> f64 {
    requested
        .map(|value| {
            if value.is_nan() {
                value
            } else {
                value.trunc().max(1.0)
            }
        })
        .unwrap_or(configured)
}

struct UsageObservation {
    carrier: Carrier,
    cache_retention: Option<crate::models::PromptCacheRetention>,
    prefix: serde_json::Value,
}

fn observe_usage(
    provider: &ModelProvider,
    request: &ProviderPromptRequest<'_>,
    config: &super::ProviderRequestConfig,
    observation: &UsageObservation,
    decoded: Option<&result::PromptDecoded>,
) -> Result<(), ModelRoundError> {
    let usage = decoded.and_then(|decoded| decoded.usage.as_ref());
    let resolved_reasoning = request
        .reasoning_effort
        .copied()
        .or(config.prompt_reasoning_effort)
        .unwrap_or(config.metadata.default_reasoning_effort);
    let openai_attribution = (config.metadata.provider_id == "openai").then(|| {
        let source = request.usage_attribution;
        crate::models::PromptUsageAttribution {
            turn_id: source.and_then(|value| value.turn_id),
            phase: source.and_then(|value| value.phase),
            round_index: source.and_then(|value| value.round_index),
            reasoning_effort: Some(&resolved_reasoning),
            requested_output_tokens: source.and_then(|value| value.requested_output_tokens),
            budget_state: source.and_then(|value| value.budget_state),
            budget_state_source: source.and_then(|value| value.budget_state_source),
            prompt_sections: source.and_then(|value| value.prompt_sections),
        }
    });
    let metric = || {
        let scope = if config.metadata.provider_id == "openai" {
            request.cache_scope.unwrap_or("text-prompt")
        } else if matches!(observation.carrier, Carrier::Chat { .. }) {
            request.cache_scope.unwrap_or("session-turn")
        } else {
            request.cache_scope.unwrap_or("btcc-agent-loop")
        };
        provider.prompt_metrics.append(PromptUsageMetricInput {
            model: usage.map_or(config.metadata.model_ref.as_str(), |usage| &usage.model),
            scope,
            prompt_tokens: usage.and_then(|usage| usage.prompt_tokens),
            cached_tokens: usage.map_or(0.0, |usage| usage.cached_tokens),
            total_tokens: usage.and_then(|usage| usage.total_tokens),
            cache_write_tokens: decoded.and_then(|decoded| decoded.cache_write_tokens),
            prompt_cache_key: None,
            prompt_cache_retention: observation.cache_retention,
            butler_data: request.butler_data,
            usage_attribution: openai_attribution.as_ref().or(request.usage_attribution),
            reasoning_tokens: decoded.and_then(|decoded| decoded.reasoning_tokens),
            cache_write_1h_tokens: decoded.and_then(|decoded| decoded.cache_write_1h_tokens),
            prefix_diagnostics: Some(&observation.prefix),
            auth_mode: Some(
                provider
                    .catalog
                    .usage_auth_mode(&config.metadata.provider_id, config.auth.mode()),
            ),
        })
    };
    metric()
}

fn cancelled(request: &ProviderPromptRequest<'_>) -> Result<(), ModelRoundError> {
    if request.cancellation.is_cancelled() {
        Err(ModelRoundError::Cancelled)
    } else {
        Ok(())
    }
}

async fn effective_model(
    provider: &ModelProvider,
    requested: Option<&str>,
) -> Result<String, ModelRoundError> {
    let config = provider.config.clone();
    let requested = requested.map(str::to_owned);
    tokio::task::spawn_blocking(move || config.effective_prompt_model(requested.as_deref()))
        .await
        .map_err(|error| ModelRoundError::InvocationFailure {
            code: Some("model_configuration_read_failed".into()),
            message: error.to_string(),
        })?
}
