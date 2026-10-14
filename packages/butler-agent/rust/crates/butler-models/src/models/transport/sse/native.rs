//! Native provider streams, assembled into the same JSON consumed by result decoding.
mod anthropic;
mod gemini;
mod responses;

use butler_turn::btcc::{ProviderRequestError, ProviderStreamObserver};
use reqwest::Response;
use serde_json::Value;

use super::super::super::{diagnostics, request_guard::RequestProgress};
use super::super::ResponseMode;

pub(in crate::models::transport) async fn read(
    response: Response,
    mode: ResponseMode,
    provider: &str,
    api: &str,
    progress: RequestProgress,
    observer: Option<&dyn ProviderStreamObserver>,
) -> Result<Value, Box<ProviderRequestError>> {
    let mut state = match mode {
        ResponseMode::AnthropicSse => State::Anthropic(anthropic::State::new()),
        ResponseMode::GeminiSse => State::Gemini(gemini::State::new()),
        _ => State::Responses(responses::State::new()),
    };
    let completed = super::consume(response, provider, api, None, |frame| {
        let event: Value = serde_json::from_str(frame)
            .map_err(|_| protocol(provider, api, "provider_stream_malformed_event"))?;
        progress.record_progress();
        stream_error(&event, provider, api)?;
        match &mut state {
            State::Anthropic(state) => state.event(&event, observer),
            State::Gemini(state) => state.event(&event, observer),
            State::Responses(state) => state.event(&event, observer),
        }
        .map_err(|code| protocol(provider, api, code))
    })
    .await?;
    if let Some(value) = completed {
        return Ok(value);
    }
    // Gemini has no terminator; its finishReason (or blocked prompt) closes the answer.
    if let State::Gemini(state) = state
        && let Some(value) = state.finish()
    {
        return Ok(value);
    }
    Err(protocol(provider, api, "provider_stream_interrupted"))
}

enum State {
    Anthropic(anthropic::State),
    Gemini(gemini::State),
    Responses(responses::State),
}

fn protocol(provider: &str, api: &str, code: &str) -> Box<ProviderRequestError> {
    Box::new(diagnostics::protocol(provider, api, code))
}

fn stream_error(event: &Value, provider: &str, api: &str) -> Result<(), Box<ProviderRequestError>> {
    let Some(error) = event
        .get("error")
        .or_else(|| event.pointer("/response/error"))
        .or_else(|| (event["type"] == "error").then_some(event))
        .filter(|value| value.is_object())
    else {
        return Ok(());
    };
    let identity = format!("{}:{}", error["type"], error["code"]).to_ascii_lowercase();
    let status = error
        .get("code")
        .and_then(Value::as_u64)
        .and_then(|n| u16::try_from(n).ok())
        .unwrap_or_else(|| {
            if identity.contains("rate") || identity.contains("too_many_requests") {
                429
            } else if identity.contains("auth") || identity.contains("api_key") {
                401
            } else if identity.contains("permission") || identity.contains("forbidden") {
                403
            } else if identity.contains("invalid") {
                400
            } else if identity.contains("service_unavailable") {
                503
            } else if identity.contains("overload") {
                529
            } else {
                500
            }
        });
    Err(Box::new(diagnostics::http(
        provider,
        api,
        status,
        Some(event),
        None,
    )))
}

fn extend(target: &mut Value, source: &Value) {
    if let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) {
        target.extend(source.clone());
    }
}
