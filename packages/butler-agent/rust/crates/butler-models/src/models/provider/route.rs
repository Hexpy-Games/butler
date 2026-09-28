//! How a provider's round travels: its carrier (request body shape),
//! response mode and API name, and the auth headers of its request.

use reqwest::RequestBuilder;

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
            .header("x-api-key", value)
            .header("anthropic-version", "2023-06-01"),
        ProviderAuth::ApiKey(value) if provider == "google" => {
            request.header("x-goog-api-key", value)
        }
        ProviderAuth::ApiKey(value) => request.bearer_auth(value),
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
