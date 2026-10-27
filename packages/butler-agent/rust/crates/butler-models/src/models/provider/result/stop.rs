//! A single allow-list for agent rounds and one-shot prompts.
use super::super::serialize::Carrier;
use butler_turn::btcc::{ModelRoundToolCall, ModelStop, ProviderRequestError, ToolCallOrigin};
use serde_json::Value;

pub(in crate::models::provider) fn classify(
    response: &Value,
    carrier: Carrier,
    usable_output: bool,
) -> ModelStop {
    if matches!(carrier, Carrier::Gemini)
        && response
            .pointer("/promptFeedback/blockReason")
            .and_then(Value::as_str)
            .is_some()
    {
        return ModelStop::Blocked;
    }
    let reason = reason(response, carrier);
    // These terminal reasons previously reached empty-response recovery. Keep
    // that path only when there is neither visible text nor a function call.
    if matches!(carrier, Carrier::Gemini)
        && matches!(reason, Some("MALFORMED_FUNCTION_CALL" | "OTHER"))
        && !usable_output
    {
        return ModelStop::Complete;
    }
    match (carrier, reason) {
        (Carrier::Anthropic, Some("max_tokens"))
        | (Carrier::Chat { .. }, Some("length"))
        | (Carrier::Gemini, Some("MAX_TOKENS")) => ModelStop::Truncated,
        (Carrier::Anthropic, Some("model_context_window_exceeded")) => ModelStop::ContextLimit,
        (Carrier::Anthropic, Some("pause_turn")) => ModelStop::Paused,
        (Carrier::Anthropic, Some("refusal")) => ModelStop::Refused,
        (Carrier::Chat { .. }, Some("content_filter"))
        | (
            Carrier::Gemini,
            Some(
                "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII"
                | "IMAGE_SAFETY",
            ),
        ) => ModelStop::Blocked,
        (Carrier::Responses, Some("incomplete")) => match response
            .pointer("/incomplete_details/reason")
            .and_then(Value::as_str)
        {
            Some("max_output_tokens") => ModelStop::Truncated,
            Some("content_filter") => ModelStop::Blocked,
            _ => ModelStop::Unrecognized(diagnostic(response, carrier)),
        },
        (Carrier::Anthropic, Some("end_turn" | "tool_use" | "stop_sequence"))
        | (Carrier::Gemini, Some("STOP"))
        | (Carrier::Responses, Some("completed"))
        | (Carrier::Chat { .. }, Some("stop" | "tool_calls" | "function_call") | None) => {
            ModelStop::Complete
        }
        _ => ModelStop::Unrecognized(diagnostic(response, carrier)),
    }
}

fn reason(response: &Value, carrier: Carrier) -> Option<&str> {
    response
        .pointer(match carrier {
            Carrier::Anthropic => "/stop_reason",
            Carrier::Responses => "/status",
            Carrier::Chat { .. } => "/choices/0/finish_reason",
            Carrier::Gemini => "/candidates/0/finishReason",
        })
        .and_then(Value::as_str)
}

fn diagnostic(response: &Value, carrier: Carrier) -> String {
    let reason = reason(response, carrier).unwrap_or("missing");
    if matches!(carrier, Carrier::Responses) {
        let detail = response
            .pointer("/incomplete_details/reason")
            .and_then(Value::as_str)
            .unwrap_or("missing");
        format!("status={reason}; incomplete_reason={detail}")
    } else {
        reason.to_owned()
    }
}

/// Unknown stops surface immediately but permit an explicit user retry.
pub(in crate::models::provider) fn error(
    stop: &ModelStop,
    response: &Value,
    carrier: Carrier,
    provider: &str,
    api: &str,
    prompt: bool,
) -> Option<Box<ProviderRequestError>> {
    let code = match stop {
        ModelStop::Complete => return None,
        ModelStop::Truncated | ModelStop::Paused if !prompt => return None,
        ModelStop::Truncated | ModelStop::Paused => "provider_output_truncated",
        ModelStop::ContextLimit => "provider_context_limit_exceeded",
        ModelStop::Refused => "provider_response_refused",
        ModelStop::Blocked => "provider_safety_error",
        ModelStop::Unrecognized(_) => "provider_stop_unrecognized",
    };
    let mut error = crate::models::diagnostics::protocol(provider, api, code);
    error.retryable = matches!(stop, ModelStop::Unrecognized(_));
    error.cause = crate::models::diagnostics::safe_text(&diagnostic(response, carrier));
    Some(Box::new(error))
}

/// Only the last call of a truncated response can have unfinished arguments.
pub(super) fn mark_truncated_call(
    response: &Value,
    carrier: Carrier,
    calls: &mut [ModelRoundToolCall],
) {
    let last_is_call = match carrier {
        Carrier::Anthropic => {
            last(response.get("content")).is_some_and(|v| v["type"] == "tool_use")
        }
        Carrier::Responses => {
            last(response.get("output")).is_some_and(|v| v["type"] == "function_call")
        }
        Carrier::Chat { .. } => true,
        Carrier::Gemini => last(response.pointer("/candidates/0/content/parts"))
            .is_some_and(|v| v.get("functionCall").is_some()),
    };
    if last_is_call && let Some(call) = calls.last_mut() {
        call.origin = Some(ToolCallOrigin::Truncated);
    }
}

fn last(items: Option<&Value>) -> Option<&Value> {
    items.and_then(Value::as_array).and_then(|v| v.last())
}
