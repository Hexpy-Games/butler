//! Physical prompt dispatch, kept separate from round recovery and lifecycle.
use super::*;
use crate::models::{ProviderObservation, ProviderRequestConfig, transport::ResponseMode};
use serde_json::Value;
pub(super) struct Dispatched {
    pub response: Result<Value, ModelRoundError>,
    pub prefix: Value,
}
pub(super) async fn run(
    provider: &ModelProvider,
    request: &ProviderPromptRequest<'_>,
    config: &ProviderRequestConfig,
    body: &Value,
    serialized: Bytes,
    route: (Carrier, ResponseMode, &'static str),
) -> Result<Dispatched, ModelRoundError> {
    let (carrier, mode, api) = route;
    if let Some(paused) = plan_limit_paused(provider, config, mode, api) {
        return Ok(Dispatched {
            response: Err(ModelRoundError::Provider(Box::new(paused))),
            prefix: Value::Null,
        });
    }
    let prefix = provider.prefix_history.prepare(body, config)?;
    let physical = super::admission(provider, request, config, body, serialized.clone(), carrier)?;
    let http = build_http(provider, config, carrier, mode, serialized.clone());
    let trace =
        super::super::request_trace::RequestTrace::prompt(provider, prefix, request).await?;
    let request_bytes = serialized.len();
    let observe = || {
        provider
            .observations
            .request(ProviderObservation { request_bytes });
    };
    let attempts = super::retry_attempts(request.provider_retry_attempts, config.retry_attempts);
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
    Ok(Dispatched {
        response,
        prefix: trace.latest().unwrap_or(Value::Null),
    })
}
/// Background prompts pause on the ChatGPT plan while its limit applies; user
/// turns still reach it, so a lifted limit is noticed and cleared.
fn plan_limit_paused(
    provider: &ModelProvider,
    config: &ProviderRequestConfig,
    mode: ResponseMode,
    api: &str,
) -> Option<butler_turn::btcc::ProviderRequestError> {
    if !matches!(mode, ResponseMode::ChatGptPlanSse) {
        return None;
    }
    let provider_id = &config.metadata.provider_id;
    let limit = provider
        .quota
        .as_deref()?
        .active_plan_limit(provider_id, provider.clock.now_epoch_millis())?;
    Some(crate::models::diagnostics::plan_limit_paused(
        provider_id,
        api,
        limit.resets_at_ms,
    ))
}
fn build_http(
    provider: &ModelProvider,
    config: &ProviderRequestConfig,
    carrier: Carrier,
    mode: ResponseMode,
    serialized: Bytes,
) -> butler_log::http::RequestBuilder {
    let mut http = provider
        .client
        .post(config.endpoint.clone())
        .header("content-type", "application/json");
    if matches!(
        mode,
        crate::models::transport::ResponseMode::HostedChatSse(_)
    ) {
        http = http.header("accept", "text/event-stream");
    }
    crate::models::provider::client::authorize(
        http.body(serialized),
        &config.auth,
        &config.metadata.provider_id,
        carrier,
    )
}
