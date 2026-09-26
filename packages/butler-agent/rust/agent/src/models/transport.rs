mod sse;

use reqwest::{Client, RequestBuilder, Response};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::btcc::{ModelRoundError, ProviderBodyAdmissionPort, ProviderRequestError};

use super::diagnostics;
use super::provider::{ProviderClock, ProviderRoundPolicy};
use super::request_admission::PreparedRequestAdmission;
use super::request_guard::{GuardError, RequestPolicy, run_guarded};

#[derive(Clone, Copy)]
pub(super) enum ResponseMode {
    Json { tolerate_invalid: bool },
    HostedChatSse,
    CodexSse,
}

#[derive(Clone, Copy)]
pub(super) enum GuardStart {
    BeforeAdmission,
    AfterAdmission,
}

enum TransportError {
    Admission(ModelRoundError),
    Provider(Box<ProviderRequestError>),
}

impl From<ProviderRequestError> for TransportError {
    fn from(error: ProviderRequestError) -> Self {
        Self::Provider(Box::new(error))
    }
}

pub(super) struct RequestExecution<'a> {
    pub request: RequestBuilder,
    pub provider: &'a str,
    pub api: &'a str,
    pub policy: ProviderRoundPolicy,
    pub external: CancellationToken,
    pub mode: ResponseMode,
    pub stream_observer: Option<&'a dyn crate::btcc::ProviderStreamObserver>,
    pub attempts: f64,
    pub admission: Option<&'a dyn ProviderBodyAdmissionPort>,
    pub physical_admission: Option<&'a PreparedRequestAdmission<'a>>,
    pub serialized_bytes: usize,
    pub guard_start: GuardStart,
    pub request_observer: &'a (dyn Fn() + Sync),
    pub clock: &'a dyn ProviderClock,
}

pub(super) async fn execute(input: RequestExecution<'_>) -> Result<Value, ModelRoundError> {
    let RequestExecution {
        request,
        provider,
        api,
        policy,
        external,
        mode,
        stream_observer,
        attempts,
        admission,
        physical_admission,
        serialized_bytes,
        guard_start,
        request_observer,
        clock,
    } = input;
    let guarded = run_guarded(
        external,
        RequestPolicy {
            total: policy.total,
            idle: policy.idle,
        },
        |progress| async move {
            if matches!(guard_start, GuardStart::BeforeAdmission) {
                progress.start();
            }
            let attempts = if attempts.is_nan() {
                0.0
            } else {
                attempts.trunc().max(1.0)
            };
            let mut observed = false;
            let mut attempt = 0_u32;
            while f64::from(attempt) < attempts {
                let receipt = physical_admission
                    .map(PreparedRequestAdmission::admit)
                    .transpose()
                    .map_err(TransportError::Admission)?;
                if let Some(admission) = admission {
                    admission
                        .admit(serialized_bytes)
                        .await
                        .map_err(TransportError::Admission)?;
                }
                if !observed {
                    request_observer();
                    observed = true;
                }
                if matches!(guard_start, GuardStart::AfterAdmission) {
                    progress.start();
                }
                let current = request.try_clone().ok_or_else(|| {
                    diagnostics::protocol(provider, api, "provider_request_not_replayable")
                })?;
                let result = async {
                    let response = current.send().await.map_err(|error| {
                        diagnostics::network(provider, api, error.to_string())
                    })?;
                    progress.record_progress();
                    let response = checked(response, provider, api).await?;
                    match mode {
                        ResponseMode::Json { tolerate_invalid } => {
                            json(response, provider, api, tolerate_invalid).await
                        }
                        ResponseMode::HostedChatSse => {
                            let is_sse = response
                                .headers()
                                .get("content-type")
                                .and_then(|value| value.to_str().ok())
                                .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));
                            if is_sse {
                                sse::hosted_chat(response, provider, api, progress.clone()).await
                            } else {
                                json(response, provider, api, true).await
                            }
                        }
                        ResponseMode::CodexSse => {
                            sse::codex(
                                response,
                                provider,
                                api,
                                progress.clone(),
                                stream_observer,
                                clock,
                            )
                            .await
                        }
                    }
                }
                .await
                .map_err(|mut error| {
                    if error.code != "provider_network_error"
                        && let Some(receipt) = receipt
                    {
                        error.request_generation = Some(receipt.plan.generation as u64);
                        error.measured_input_tokens = Some(receipt.plan.compiled_input_tokens as u64);
                        error.registered_input_capacity = Some(receipt.plan.input_capacity_tokens as u64);
                        error.request_hash = Some(receipt.request_hash);
                    }
                    TransportError::Provider(error)
                });
                match result {
                    Ok(value) => return Ok(value),
                    Err(TransportError::Provider(error))
                        if error.retryable && f64::from(attempt + 1) < attempts =>
                    {
                        let delay = retry_delay_ms(policy.retry_base_ms, attempt);
                        if delay > 0.0 {
                            let cancellation = progress.cancellation();
                            tokio::select! {
                                _ = cancellation.cancelled() => {
                                    return Err(TransportError::Provider(Box::new(diagnostics::cancelled(provider, api))));
                                }
                                _ = tokio::time::sleep(std::time::Duration::from_millis(delay.trunc() as u64)) => {}
                            }
                        }
                    }
                    Err(error) => return Err(error),
                }
                attempt = attempt.saturating_add(1);
            }
            Err(TransportError::Admission(ModelRoundError::InvocationFailure {
                code: None,
                message: "undefined".into(),
            }))
        },
    )
    .await;
    match guarded {
        Ok(value) => Ok(value),
        Err(GuardError::Operation(TransportError::Admission(error))) => Err(error),
        Err(GuardError::Operation(TransportError::Provider(error))) => {
            Err(ModelRoundError::Provider(error))
        }
        Err(GuardError::Cancelled) => Err(ModelRoundError::Provider(Box::new(
            diagnostics::cancelled(provider, api),
        ))),
        Err(GuardError::Timeout(kind)) => {
            Err(ModelRoundError::Provider(Box::new(diagnostics::timeout(
                provider,
                api,
                match kind {
                    super::request_guard::TimeoutKind::Total => "total",
                    super::request_guard::TimeoutKind::Idle => "idle",
                },
            ))))
        }
    }
}

fn retry_delay_ms(base: f64, attempt: u32) -> f64 {
    let raw = base * 2_f64.powf(f64::from(attempt));
    let delay = if raw.is_nan() { 0.0 } else { raw.min(5_000.0) };
    if delay.is_finite() && delay > 0.0 {
        delay
    } else {
        0.0
    }
}

async fn json(
    response: Response,
    provider: &str,
    api: &str,
    tolerate_invalid: bool,
) -> Result<Value, Box<ProviderRequestError>> {
    let bytes = response
        .bytes()
        .await
        .map_err(|error| Box::new(diagnostics::network(provider, api, error.to_string())))?;
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    match serde_json::from_str(text) {
        Ok(value) => Ok(value),
        Err(_) if tolerate_invalid => Ok(Value::Object(serde_json::Map::new())),
        Err(_) => Err(Box::new(diagnostics::protocol(
            provider,
            api,
            "provider_invalid_json",
        ))),
    }
}

async fn checked(
    response: Response,
    provider: &str,
    api: &str,
) -> Result<Response, Box<ProviderRequestError>> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response.text().await.ok();
    let parsed = body
        .as_deref()
        .and_then(|value| serde_json::from_str(value).ok());
    Err(Box::new(diagnostics::http(
        provider,
        api,
        status,
        parsed.as_ref(),
        Some(&headers),
    )))
}

pub(crate) fn provider_http_client() -> Result<Client, reqwest::Error> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::limited(20))
        .build()
}
