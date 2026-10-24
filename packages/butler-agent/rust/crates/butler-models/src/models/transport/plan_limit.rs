//! Plan state is based exclusively on terminal response outcomes.
use super::{QuotaObserver, Reading, ResponseMode, checked, timing};
use crate::models::{PlanLimitReading, diagnostics};
use butler_turn::btcc::ProviderRequestError;
use reqwest::Response;
use reqwest::header::HeaderMap;
use serde_json::Value;
pub(super) async fn read(
    response: Response,
    mode: ResponseMode,
    quota: QuotaObserver<'_>,
    reading: Reading<'_>,
    timing: &timing::Timing,
) -> Result<Value, Box<ProviderRequestError>> {
    let headers = response.headers().clone();
    let provider = reading.provider;
    let api = reading.api;
    let mut result = match checked(response, provider, api, quota).await {
        Ok(response) => {
            timing.mark("headers_checked");
            reading.read(response, mode).await
        }
        Err(error) => Err(error),
    };
    observe(mode, provider, quota, &headers, &mut result);
    result
}

fn observe(
    mode: ResponseMode,
    provider: &str,
    (sink, clock): QuotaObserver<'_>,
    headers: &HeaderMap,
    result: &mut Result<Value, Box<ProviderRequestError>>,
) {
    if !matches!(mode, ResponseMode::ChatGptPlanSse) {
        return;
    }
    if let Err(error) = result {
        let headers_error = diagnostics::http(
            provider,
            "chatgpt_plan_responses",
            error.status_code.unwrap_or(502),
            None,
            Some(headers),
        );
        error.provider_request_id = error
            .provider_request_id
            .take()
            .or(headers_error.provider_request_id);
        error.retry_at = error.retry_at.take().or(headers_error.retry_at);
    }
    let Some(sink) = sink else {
        return;
    };
    match result {
        Ok(_) => sink.plan_limit(provider, None),
        Err(error) if error.code == "provider_quota_exhausted" => {
            let retry_at = error.retry_at.clone().or_else(|| {
                diagnostics::http(provider, "chatgpt_plan_responses", 429, None, Some(headers))
                    .retry_at
            });
            let resets_at_ms = retry_at
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|t| t.timestamp_millis());
            sink.plan_limit(
                provider,
                Some(PlanLimitReading {
                    observed_at_ms: clock.now_epoch_millis(),
                    resets_at_ms,
                }),
            );
        }
        _ => {}
    }
}
