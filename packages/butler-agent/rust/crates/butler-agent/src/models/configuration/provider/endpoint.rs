use url::Url;

use super::{ModelConfiguration, provider_error_for};
use crate::btcc::ProviderRequestError;
use crate::models::{
    HostedApiShape, RegisteredHostedModelConfig, default_hosted_provider_api_base_url,
};

pub(super) fn resolve(
    configuration: &ModelConfiguration,
    provider: &str,
    model: &str,
    shape: Option<HostedApiShape>,
    registered: Option<&RegisteredHostedModelConfig>,
    local_base: Option<&str>,
    auth: crate::models::ProviderAuthMode,
) -> Result<Url, Box<ProviderRequestError>> {
    if provider == "openai" {
        let base = if matches!(
            auth,
            crate::models::ProviderAuthMode::CodexOauth
                | crate::models::ProviderAuthMode::CodexSubscription
        ) {
            trim_slashes(
                configuration
                    .environment
                    .codex_base_url
                    .as_deref()
                    .unwrap_or("https://chatgpt.com/backend-api"),
            )
        } else {
            trim_slashes(
                configuration
                    .environment
                    .openai_base_url
                    .as_deref()
                    .unwrap_or("https://api.openai.com/v1"),
            )
        };
        let value = if matches!(
            auth,
            crate::models::ProviderAuthMode::CodexOauth
                | crate::models::ProviderAuthMode::CodexSubscription
        ) {
            if base.ends_with("/codex/responses") {
                base
            } else if base.ends_with("/codex") {
                format!("{base}/responses")
            } else {
                format!("{base}/codex/responses")
            }
        } else if base.ends_with("/responses") {
            base
        } else {
            format!("{base}/responses")
        };
        return parse_endpoint(provider, &value);
    }
    if provider == "local" {
        let Some(base) = local_base else {
            return Err(Box::new(provider_error_for(
                provider,
                "provider_configuration_missing",
                "configuration",
                "Local model is not registered.",
            )));
        };
        let base = trim_slashes(base);
        let url = if base.ends_with("/chat/completions") {
            base
        } else {
            format!("{base}/chat/completions")
        };
        return parse_endpoint(provider, &url);
    }
    let base = registered
        .and_then(|value| value.api_base_url.clone())
        .or_else(|| {
            configuration
                .environment
                .hosted_provider_base_urls
                .get(provider)
                .cloned()
        })
        .or_else(|| default_hosted_provider_api_base_url(provider).map(str::to_owned))
        .unwrap_or_else(|| match provider {
            "anthropic" => "https://api.anthropic.com/v1".into(),
            "google" => "https://generativelanguage.googleapis.com/v1beta".into(),
            _ => "https://api.openai.com/v1".into(),
        });
    let base = trim_slashes(&base);
    let suffix = match (provider, shape) {
        ("anthropic", _) | ("opencode-go", Some(HostedApiShape::AnthropicMessages)) => "messages",
        ("google", _) => return parse_endpoint(provider, &gemini_endpoint(&base, model)),
        (_, Some(HostedApiShape::OpenaiResponses)) => "responses",
        _ => "chat/completions",
    };
    let url = if base.ends_with(&format!("/{suffix}")) {
        base
    } else {
        format!("{base}/{suffix}")
    };
    parse_endpoint(provider, &url)
}

fn trim_slashes(value: &str) -> String {
    crate::public_text::trim_js_whitespace(value)
        .trim_end_matches('/')
        .to_owned()
}
fn gemini_endpoint(base: &str, model: &str) -> String {
    if base.contains(":generateContent") {
        return base.into();
    }
    let model = url::form_urlencoded::byte_serialize(model.as_bytes()).collect::<String>();
    format!("{base}/models/{model}:generateContent")
}
fn parse_endpoint(provider: &str, value: &str) -> Result<Url, Box<ProviderRequestError>> {
    Url::parse(value).map_err(|_| {
        Box::new(provider_error_for(
            provider,
            "provider_endpoint_invalid",
            "configuration",
            "Provider endpoint is invalid.",
        ))
    })
}
