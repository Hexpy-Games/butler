//! How a provider's round travels: its carrier (request body shape),
//! response mode and API name, and the auth headers of its request.

use reqwest::RequestBuilder;
use serde_json::Value;

use super::super::{HostedApiShape, transport};
use super::contracts::{ProviderAuth, ProviderAuthMode};
use super::serialize::Carrier;

pub(in crate::models::provider) fn carrier(
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

pub(in crate::models::provider) fn authorize(
    request: RequestBuilder,
    auth: &ProviderAuth,
    provider: &str,
    carrier: Carrier,
) -> RequestBuilder {
    match auth {
        ProviderAuth::None => request,
        ProviderAuth::ApiKey(value) if matches!(carrier, Carrier::Anthropic) => request
            .header("x-api-key", value.as_str())
            .header("anthropic-version", "2023-06-01"),
        ProviderAuth::ApiKey(value) if provider == "google" => {
            request.header("x-goog-api-key", value.as_str())
        }
        ProviderAuth::ApiKey(value) => request.bearer_auth(value.as_str()),
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

/// ChatGPT routes cache affinity by session-id, rather than the body key alone.
/// Match Codex's Responses session identity to our existing cache scope.
/// Consume the body projection to free it before sending the serialized bytes.
pub(in crate::models::provider) fn cache_affinity(
    request: RequestBuilder,
    auth: &ProviderAuth,
    body: Value,
) -> RequestBuilder {
    let request = if matches!(auth, ProviderAuth::Codex { .. })
        && let Some(key) = body.get("prompt_cache_key").and_then(Value::as_str)
        && let Ok(value) = reqwest::header::HeaderValue::from_str(key)
    {
        request.header("session-id", value)
    } else {
        request
    };
    drop(body);
    request
}
