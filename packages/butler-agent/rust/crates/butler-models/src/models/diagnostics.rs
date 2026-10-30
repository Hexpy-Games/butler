const REQUEST_ID_HEADERS: &[&str] = &[
    "openai-request-id",
    "x-oai-request-id",
    "x-request-id",
    "request-id",
    "x-zai-request-id",
];
pub(super) mod plan;
use butler_core::public_text::fixed_regex;
use std::sync::LazyLock;

use regex::Regex;
use reqwest::header::HeaderMap;
use serde_json::{Map, Value};

use butler_turn::btcc::ProviderRequestError;

pub(super) fn cancelled(provider: &str, api: &str) -> ProviderRequestError {
    error(
        "provider_cancelled",
        "Provider request was cancelled.",
        provider,
        api,
        false,
    )
}

/// `kind` `first_response`: no response event came within the limit, so the
/// route does not resend the same request (a person still can).
pub(super) fn timeout(provider: &str, api: &str, kind: &str) -> ProviderRequestError {
    let (code, message) = if kind == "first_response" {
        (
            "provider_first_response_timeout",
            "Model provider sent no response within the response time limit.",
        )
    } else {
        (
            "provider_round_timeout",
            "Model provider stopped making forward progress. Butler preserved the current turn checkpoint and will continue after provider recovery.",
        )
    };
    let mut failure = error(code, message, provider, api, true);
    failure.timeout_kind = Some(kind.into());
    failure
}

pub(super) fn network(provider: &str, api: &str, cause: &str) -> ProviderRequestError {
    let mut failure = error(
        "provider_network_error",
        "Model provider API connection failed before a response was received.",
        provider,
        api,
        true,
    );
    failure.cause = safe_text(cause);
    failure
}

pub(super) fn protocol(provider: &str, api: &str, code: &str) -> ProviderRequestError {
    let (message, retryable) = if code == "provider_stream_interrupted" {
        (
            "Model provider response stream ended before completion. Butler will apply the configured provider recovery policy.",
            true,
        )
    } else {
        ("Model provider returned an invalid response.", false)
    };
    error(code, message, provider, api, retryable)
}

pub(super) fn empty(provider: &str, api: &str) -> ProviderRequestError {
    error(
        "provider_empty_response",
        "Model provider returned no visible answer. Butler preserved the turn for provider recovery.",
        provider,
        api,
        true,
    )
}

/// A ChatGPT-plan request held back because the plan limit still applies; it
/// fails the way the provider's limit response does, without being sent.
pub(super) fn plan_limit_paused(
    provider: &str,
    api: &str,
    resets_at_ms: Option<i64>,
) -> ProviderRequestError {
    let code = "provider_quota_exhausted";
    let mut failure = error(code, http_message(code), provider, api, false);
    failure.retry_at = resets_at_ms
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|at| at.to_rfc3339());
    failure
}

pub(super) fn http(
    provider: &str,
    api: &str,
    status: u16,
    body: Option<&Value>,
    headers: Option<&HeaderMap>,
) -> ProviderRequestError {
    let identity = body
        .and_then(Value::as_object)
        .and_then(|body| body.get("error").and_then(Value::as_object).or(Some(body)));
    let provider_code = string(identity, &["code", "error_code", "errorCode"]);
    let provider_type = string(identity, &["type", "error_type", "errorType", "status"]);
    let detail = string(
        identity,
        &["message", "error_message", "errorMessage", "detail"],
    );
    let tools_refused = matches!(status, 400 | 422)
        && refuses_tools(string(identity, &["param"]).as_deref(), detail.as_deref());
    let plan = plan::classify(api, status, body);
    let normalized = if let Some((code, _)) = plan {
        Some(code)
    } else if tools_refused {
        Some("provider_tools_unsupported")
    } else {
        normalized_code(
            provider_code.as_deref(),
            provider_type.as_deref(),
            detail.as_deref(),
        )
    };
    let context = detail.as_deref().is_some_and(is_context_limit);
    let code = normalized.unwrap_or({
        if context {
            "provider_context_limit_exceeded"
        } else if matches!(status, 401 | 403) {
            "provider_auth_error"
        } else if status == 429 {
            "provider_rate_limited"
        } else {
            "provider_api_error"
        }
    });
    let retryable = plan.map_or(
        normalized.is_none() && !context && (status == 429 || status >= 500),
        |(_, retryable)| retryable,
    );
    let message = http_message(code);
    let mut failure = error(code, message, provider, api, retryable);
    failure.status_code = Some(status);
    failure.provider_error_code = provider_code;
    failure.provider_error_type = provider_type;
    failure.cause = detail.and_then(|value| safe_text(&value));
    failure.provider_error_details = identity
        .cloned()
        .map(Value::Object)
        .and_then(|value| sanitize(&value, 0))
        .map(Box::new);
    failure.provider_request_id = header(headers, REQUEST_ID_HEADERS);
    failure.retry_at = headers.and_then(retry::at);
    let retry_after = header(headers, &["retry-after"]);
    let reset = header(headers, &["ratelimit-reset", "x-ratelimit-reset"]);
    let limit = header(headers, &["ratelimit-limit", "x-ratelimit-limit"]);
    let remaining = header(headers, &["ratelimit-remaining", "x-ratelimit-remaining"]);
    if retry_after.is_some() || reset.is_some() || limit.is_some() || remaining.is_some() {
        failure.rate_limit = Some(Box::new(serde_json::json!({
            "retryAfter": retry_after,
            "reset": reset,
            "limit": limit,
            "remaining": remaining,
        })));
    }
    failure
}

/// The safe message for a normalized HTTP failure `code`.
fn http_message(code: &str) -> &'static str {
    match code {
        "provider_quota_exhausted" => {
            "Model provider reported that the configured quota, credit, or billing limit is exhausted."
        }
        "provider_model_not_found" => {
            "Model provider reported that the configured model was not found."
        }
        "provider_model_retired" => "Model provider reported that the configured model is retired.",
        "provider_model_unavailable" => {
            "Model provider reported that the configured model is unavailable."
        }
        "provider_unsupported_model" => {
            "Model provider reported that the configured model is unsupported."
        }
        "provider_tools_unsupported" => {
            "Model provider reported that the configured model or server does not support tool calls."
        }
        "provider_context_limit_exceeded" => {
            "Model provider context limit was exceeded. Compact or reduce the session context, then retry."
        }
        "provider_auth_error" => {
            "Model provider authentication failed. Check the configured provider credentials."
        }
        "provider_rate_limited" => {
            "Model provider API rate limit was reached. Retry after provider readiness."
        }
        _ => "Model provider API request failed.",
    }
}

fn error(
    code: &str,
    message: &str,
    provider: &str,
    api: &str,
    retryable: bool,
) -> ProviderRequestError {
    ProviderRequestError {
        auth_type: None,
        code: code.into(),
        message: message.into(),
        provider: provider.into(),
        api: api.into(),
        status_code: None,
        endpoint: None,
        model: None,
        retryable,
        cause: None,
        request_generation: None,
        measured_input_tokens: None,
        registered_input_capacity: None,
        request_hash: None,
        timeout_kind: None,
        retry_at: None,
        provider_request_id: None,
        rate_limit: None,
        provider_error_code: None,
        provider_error_type: None,
        provider_error_details: None,
    }
}

fn bounded(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn string(value: Option<&Map<String, Value>>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value?
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| bounded(value, 160))
    })
}

fn normalized_code(
    code: Option<&str>,
    kind: Option<&str>,
    message: Option<&str>,
) -> Option<&'static str> {
    let identity = format!("{} {}", signal(code), signal(kind));
    let message = message.unwrap_or("").to_ascii_lowercase();
    if contains(
        &identity,
        &[
            "model_retired",
            "model_deprecated",
            "model_decommissioned",
            "model_disabled",
        ],
    ) || mentions_model(
        &message,
        &["retired", "deprecated", "decommissioned", "disabled"],
    ) {
        Some("provider_model_retired")
    } else if contains(
        &identity,
        &[
            "unsupported_model",
            "model_not_supported",
            "model_unsupported",
        ],
    ) || mentions_model(&message, &["unsupported", "not supported"])
    {
        Some("provider_unsupported_model")
    } else if contains(&identity, &["model_unavailable"])
        || mentions_model(&message, &["unavailable", "not available"])
    {
        Some("provider_model_unavailable")
    } else if contains(
        &identity,
        &[
            "model_not_found",
            "model_missing",
            "unknown_model",
            "invalid_model",
        ],
    ) || (message.contains("model")
        && ["not found", "does not exist", "unknown", "missing"]
            .iter()
            .any(|term| message.contains(term)))
    {
        Some("provider_model_not_found")
    } else if quota::matches(
        &identity,
        &[
            "usage_limit_exceeded",
            "insufficient_quota",
            "quota_exceeded",
            "quota_exhausted",
            "quota_depleted",
            "billing_hard_limit_reached",
            "billing_limit_exceeded",
            "credit_exhausted",
            "credits_exhausted",
            "insufficient_credits",
            "payment_required",
            "resource_exhausted",
        ],
    ) || [
        "quota",
        "credit balance",
        "billing hard limit",
        "payment required",
    ]
    .iter()
    .any(|term| message.contains(term))
    {
        Some("provider_quota_exhausted")
    } else {
        None
    }
}

/// Whether a rejected request says the server or model cannot take tools:
/// the standard OpenAI error `param` is `tools` or `tool_choice`, or the
/// message states that tool calling as a whole is unsupported or disabled.
/// Errors about a particular tool call or history stay ordinary API errors
/// the model can act on.
fn refuses_tools(param: Option<&str>, message: Option<&str>) -> bool {
    let param = param.unwrap_or("").to_ascii_lowercase();
    if ["tools", "tool_choice", "functions", "function_call"].contains(&param.as_str()) {
        return true;
    }
    let message = message.unwrap_or("").to_ascii_lowercase();
    const SUBJECTS: [&str; 6] = [
        "tools",
        "tool calls",
        "tool calling",
        "tool use",
        "function calling",
        "function calls",
    ];
    SUBJECTS.iter().any(|subject| {
        [
            format!("does not support {subject}"),
            format!("doesn't support {subject}"),
            format!("do not support {subject}"),
            format!("{subject} is not supported"),
            format!("{subject} are not supported"),
            format!("{subject} is not enabled"),
            format!("{subject} are not enabled"),
            format!("{subject} not supported"),
        ]
        .iter()
        .any(|phrase| message.contains(phrase.as_str()))
    })
}

fn signal(value: Option<&str>) -> String {
    value
        .unwrap_or("")
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

fn contains(identity: &str, values: &[&str]) -> bool {
    identity
        .split_whitespace()
        .any(|token| values.contains(&token.trim_matches('_')))
}

fn mentions_model(message: &str, terms: &[&str]) -> bool {
    message.contains("model") && terms.iter().any(|term| message.contains(term))
}

fn is_context_limit(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    [
        "context length",
        "context window",
        "maximum context",
        "too many tokens",
        "token limit",
        "prompt is too long",
    ]
    .iter()
    .any(|term| value.contains(term))
}

pub(crate) fn safe_text(value: &str) -> Option<String> {
    let words = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if words.is_empty() {
        return None;
    }
    static SECRET: LazyLock<Regex> = LazyLock::new(|| {
        fixed_regex(
            r"(?i)\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+|Bearer\s+[A-Za-z0-9._~+/=-]+|\b(sk|pk|rk|key)[-_][A-Za-z0-9_-]{6,}",
        )
    });
    // Long opaque runs mixing letters and digits (echoed keys, tokens).
    static OPAQUE: LazyLock<Regex> = LazyLock::new(|| fixed_regex(r"[A-Za-z0-9_+/=-]{32,}"));
    let named = SECRET.replace_all(&words, "[redacted]");
    let opaque = OPAQUE.replace_all(&named, |found: &regex::Captures<'_>| {
        let text = &found[0];
        if text.chars().any(|c| c.is_ascii_digit()) && text.chars().any(|c| c.is_ascii_alphabetic())
        {
            "[redacted]".to_owned()
        } else {
            text.to_owned()
        }
    });
    Some(bounded(&opaque, 500))
}

fn header(headers: Option<&HeaderMap>, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        headers?
            .get(*name)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.replace(['\r', '\n'], " "))
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .as_ref()
            .map(|value| bounded(value, 160))
    })
}

fn sanitize(value: &Value, depth: usize) -> Option<Value> {
    if depth >= 3 {
        return Some(Value::String("[truncated]".into()));
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Some(value.clone()),
        Value::String(value) => safe_text(value).map(Value::String),
        Value::Array(values) => Some(Value::Array(
            values
                .iter()
                .take(24)
                .filter_map(|value| sanitize(value, depth + 1))
                .collect(),
        )),
        Value::Object(values) => {
            let mut output = Map::new();
            for (key, value) in values.iter().take(24) {
                let key = bounded(
                    &key.chars()
                        .map(|character| {
                            if character.is_ascii_alphanumeric() || "_.:@/-".contains(character) {
                                character
                            } else {
                                '_'
                            }
                        })
                        .collect::<String>(),
                    120,
                );
                let private = key.to_ascii_lowercase();
                let value = if [
                    "api_key",
                    "apikey",
                    "access_token",
                    "token",
                    "secret",
                    "password",
                    "authorization",
                    "credential",
                ]
                .iter()
                .any(|term| private.contains(term))
                {
                    Some(Value::String("[redacted]".into()))
                } else {
                    sanitize(value, depth + 1)
                };
                if let Some(value) = value {
                    output.insert(key, value);
                }
            }
            Some(Value::Object(output))
        }
    }
}
mod retry;

mod quota;
