mod attachments;
mod result;
mod serialize;

use bytes::Bytes;

use crate::{
    btcc::ModelRoundError,
    models::{
        PromptUsageMetricInput, ProviderConfigRequest, ProviderPromptFuture,
        ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest, ProviderPromptResult,
    },
};

use super::{NativeModelProvider, ProviderObservation, serialize::Carrier};

impl ProviderPromptPort for NativeModelProvider {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        Box::pin(run(self, request, lifecycle))
    }
}

async fn run(
    provider: &NativeModelProvider,
    request: ProviderPromptRequest<'_>,
    lifecycle: ProviderPromptLifecycle<'_>,
) -> Result<ProviderPromptResult, ModelRoundError> {
    cancelled(&request)?;
    let effective_model = provider.config.effective_prompt_model(request.model)?;
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
    let (carrier, mode, api) = super::native::carrier(&config);
    let serialize::PromptWire {
        body,
        cache_key,
        cache_retention,
    } = serialize::body(&request, &config, carrier)?;
    let serialized =
        crate::json::stringify(&body).map_err(|error| ModelRoundError::InvocationFailure {
            code: Some("prompt_serialization_failed".into()),
            message: error.to_string(),
        })?;
    let serialized = Bytes::from(serialized);
    let physical = crate::models::request_admission::PreparedRequestAdmission::new(
        &crate::models::request_admission::PrepareAdmissionInput {
            catalog: &provider.catalog,
            config: provider.config.as_ref(),
            provider: &config.metadata.provider_id,
            model_ref: &config.metadata.model_ref,
            butler_data: None,
            requested_output_tokens: super::serialize::requested_output_tokens(
                &body,
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
            body: &body,
            serialized: serialized.clone(),
        },
    )?;
    drop(body);
    let request_bytes = serialized.len();
    let observe = || {
        provider
            .observations
            .request(ProviderObservation { request_bytes });
    };
    let mut http = provider
        .client
        .post(config.endpoint.clone())
        .header("content-type", "application/json");
    if matches!(mode, crate::models::transport::ResponseMode::HostedChatSse) {
        http = http.header("accept", "text/event-stream");
    }
    let http = super::native::authorize(
        http.body(serialized.clone()),
        &config.auth,
        &config.metadata.provider_id,
        carrier,
    );
    let attempts = request
        .provider_retry_attempts
        .map(|value| {
            if value.is_nan() {
                value
            } else {
                value.trunc().max(1.0)
            }
        })
        .unwrap_or(config.retry_attempts);
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
        clock: provider.clock.as_ref(),
    })
    .await;
    let response = match response {
        Ok(value) => value,
        Err(ModelRoundError::Provider(mut error)) => {
            error.endpoint = Some(super::native::safe_endpoint(&config.endpoint));
            error.model = Some(config.wire_model.clone());
            provider.observations.failure(&error);
            return Err(ModelRoundError::Provider(error));
        }
        Err(error) => return Err(error),
    };
    let reported_model = if config.metadata.provider_id == "openai" {
        config.wire_model.as_str()
    } else {
        config.metadata.model_ref.as_str()
    };
    let decoded = result::decode(&response, reported_model, carrier);
    observe_usage(
        provider,
        &request,
        &config,
        UsageObservation {
            carrier,
            cache_key: cache_key.as_deref(),
            cache_retention,
        },
        &decoded,
    )?;
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

#[derive(Clone, Copy)]
struct UsageObservation<'a> {
    carrier: Carrier,
    cache_key: Option<&'a str>,
    cache_retention: Option<crate::models::PromptCacheRetention>,
}

fn observe_usage(
    provider: &NativeModelProvider,
    request: &ProviderPromptRequest<'_>,
    config: &super::ProviderRequestConfig,
    observation: UsageObservation<'_>,
    decoded: &result::PromptDecoded,
) -> Result<(), ModelRoundError> {
    let Some(usage) = decoded.usage.as_ref() else {
        return Ok(());
    };
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
            model: &usage.model,
            scope,
            prompt_tokens: usage.prompt_tokens,
            cached_tokens: usage.cached_tokens,
            total_tokens: usage.total_tokens,
            cache_write_tokens: decoded.cache_write_tokens,
            prompt_cache_key: observation.cache_key,
            prompt_cache_retention: observation.cache_retention,
            butler_data: request.butler_data,
            usage_attribution: openai_attribution.as_ref().or(request.usage_attribution),
        })
    };
    if config.metadata.provider_id == "openai" {
        metric()?;
    } else if !matches!(observation.carrier, Carrier::Responses) {
        let metric_context = matches!(observation.carrier, Carrier::Chat { .. })
            || request.butler_data.is_some()
            || request.cache_scope.is_some();
        if metric_context {
            metric()?;
        }
    }
    Ok(())
}

fn cancelled(request: &ProviderPromptRequest<'_>) -> Result<(), ModelRoundError> {
    if request.cancellation.is_cancelled() {
        Err(ModelRoundError::Cancelled)
    } else {
        Ok(())
    }
}
