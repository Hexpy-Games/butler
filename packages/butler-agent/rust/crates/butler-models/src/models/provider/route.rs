//! How a provider's round travels: its carrier (request body shape),
//! response mode and API name, and the auth headers of its request.

use butler_log::http::RequestBuilder;

use super::super::{HostedApiShape, transport};
use super::contracts::{ProviderAuth, ProviderAuthMode};
use super::serialize::Carrier;

pub(in crate::models::provider) fn carrier(
    config: &super::contracts::ProviderRequestConfig,
) -> (Carrier, transport::ResponseMode, &'static str) {
    if config.metadata.provider_id == "openai" {
        return if matches!(config.auth.mode(), ProviderAuthMode::ChatGptPlan) {
            (
                Carrier::Responses,
                transport::ResponseMode::ChatGptPlanSse,
                "chatgpt_plan_responses",
            )
        } else {
            (
                Carrier::Responses,
                transport::ResponseMode::ResponsesSse,
                "responses",
            )
        };
    }
    match (config.metadata.provider_id.as_str(), config.api_shape) {
        ("anthropic", _) | ("opencode-go", Some(HostedApiShape::AnthropicMessages)) => (
            Carrier::Anthropic,
            transport::ResponseMode::AnthropicSse,
            "messages",
        ),
        ("google", _) => (
            Carrier::Gemini,
            transport::ResponseMode::GeminiSse { call_round: 0 },
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
            transport::ResponseMode::ResponsesSse,
            "responses",
        ),
        _ => (
            Carrier::Chat { stream: true },
            transport::ResponseMode::HostedChatSse(config.metadata.chat_wire_policy),
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
        ProviderAuth::ChatGptPlan { authorization, .. } => request
            .header("authorization", authorization.as_str())
            .header("accept", "text/event-stream"),
    }
}

/// Keep configured endpoints usable for probes while selecting Gemini SSE for rounds.
pub(super) fn stream_endpoint(endpoint: &url::Url, mode: transport::ResponseMode) -> url::Url {
    let mut endpoint = endpoint.clone();
    if matches!(mode, transport::ResponseMode::GeminiSse { .. }) {
        let path = endpoint
            .path()
            .replace(":generateContent", ":streamGenerateContent");
        endpoint.set_path(&path);
        let query: Vec<_> = endpoint
            .query_pairs()
            .filter(|(key, _)| key != "alt")
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        endpoint.set_query(None);
        endpoint
            .query_pairs_mut()
            .extend_pairs(query)
            .append_pair("alt", "sse");
    }
    endpoint
}
