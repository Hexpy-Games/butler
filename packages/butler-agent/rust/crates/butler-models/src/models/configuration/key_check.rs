//! Checks a provider API key against the provider's model list without
//! storing it (first-run setup, #230). The key is sent only to the
//! provider's own API base URL, never logged, and never echoed in errors.

use std::time::Duration;

use reqwest::{Client, RequestBuilder, redirect::Policy};
use serde_json::Value;

use super::super::catalog::hosted_provider;
use super::ModelConfiguration;
use crate::models::default_hosted_provider_api_base_url;

const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_LISTED_MODELS: usize = 500;

/// A key the provider did not reject.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderKeyCheck {
    /// Model ids the provider listed for the key.
    pub models: Vec<String>,
    /// False when the provider has no model list to ask: the key was not
    /// rejected, but it could not be checked either.
    pub verified: bool,
}

/// Why a provider key check failed. `Display` is the public message.
#[derive(Debug, thiserror::Error)]
pub enum ProviderKeyCheckError {
    #[error("The provider rejected this API key.")]
    InvalidKey,
    #[error("This API key has no access to the provider's models, or its quota is used up.")]
    NoAccess,
    #[error("The provider is limiting requests. Try again shortly.")]
    RateLimited,
    #[error("The provider could not be reached.")]
    Network {
        #[source]
        source: Option<reqwest::Error>,
    },
    #[error("The provider answered with HTTP {status}.")]
    ProviderUnavailable { status: u16 },
    #[error("This provider is not connected with an API key.")]
    UnsupportedProvider,
    #[error("The API key is empty or contains line breaks.")]
    MalformedKey,
}

impl ProviderKeyCheckError {
    /// The stable public error code (the App maps it to a plain reason).
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidKey => "invalid_key",
            Self::NoAccess => "no_access",
            Self::RateLimited => "rate_limited",
            Self::Network { .. } => "network",
            Self::ProviderUnavailable { .. } => "provider_unavailable",
            Self::UnsupportedProvider => "unsupported_provider",
            Self::MalformedKey => "invalid_request",
        }
    }
}

impl ModelConfiguration {
    /// Asks `provider_id`'s model list endpoint whether it accepts `api_key`.
    /// Nothing is stored.
    pub async fn check_provider_key(
        &self,
        provider_id: &str,
        api_key: &str,
    ) -> Result<ProviderKeyCheck, ProviderKeyCheckError> {
        let (provider, key) = provider_key(provider_id, api_key)?;
        let url = format!("{}/models", self.provider_api_base(&provider));
        let client = Client::builder()
            .redirect(Policy::none())
            .timeout(CHECK_TIMEOUT)
            .build()
            .map_err(|source| ProviderKeyCheckError::Network {
                source: Some(source),
            })?;
        let response = authorize(client.get(url), &provider, key)
            .send()
            .await
            .map_err(|source| ProviderKeyCheckError::Network {
                source: Some(source),
            })?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        classify(status, body.as_ref())
    }

    /// The API base URL model requests use for `provider` (environment
    /// override first), without a trailing slash.
    fn provider_api_base(&self, provider: &str) -> String {
        let configured = if provider == "openai" {
            self.environment.openai_base_url.clone()
        } else {
            self.environment
                .hosted_provider_base_urls
                .get(provider)
                .cloned()
        };
        let base = configured
            .or_else(|| default_hosted_provider_api_base_url(provider).map(str::to_owned))
            .unwrap_or_else(|| {
                match provider {
                    "anthropic" => "https://api.anthropic.com/v1",
                    "google" => "https://generativelanguage.googleapis.com/v1beta",
                    _ => "https://api.openai.com/v1",
                }
                .to_owned()
            });
        let base = butler_core::public_text::trim_js_whitespace(&base).trim_end_matches('/');
        ["/responses", "/chat/completions", "/messages"]
            .iter()
            .find_map(|suffix| base.strip_suffix(suffix))
            .unwrap_or(base)
            .to_owned()
    }
}

/// The hosted provider and the key as it is sent and stored: surrounding
/// whitespace removed, never empty, no control characters (a key is sent
/// as a header value). Checking and saving a key share this rule.
pub(super) fn provider_key<'a>(
    provider_id: &str,
    api_key: &'a str,
) -> Result<(String, &'a str), ProviderKeyCheckError> {
    let provider =
        hosted_provider(provider_id).ok_or(ProviderKeyCheckError::UnsupportedProvider)?;
    let key = butler_core::public_text::trim_js_whitespace(api_key);
    if key.is_empty() || key.chars().any(char::is_control) {
        return Err(ProviderKeyCheckError::MalformedKey);
    }
    Ok((provider, key))
}

fn authorize(request: RequestBuilder, provider: &str, key: &str) -> RequestBuilder {
    match provider {
        "anthropic" => request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
        "google" => request.header("x-goog-api-key", key),
        _ => request.bearer_auth(key),
    }
}

/// The outcome of a model list answer: `status` and its JSON body.
pub(super) fn classify(
    status: u16,
    body: Option<&Value>,
) -> Result<ProviderKeyCheck, ProviderKeyCheckError> {
    match status {
        200..=299 => Ok(ProviderKeyCheck {
            models: model_ids(body),
            verified: true,
        }),
        401 => Err(ProviderKeyCheckError::InvalidKey),
        400 if mentions(
            body,
            &["api_key_invalid", "api key", "apikey", "invalid_api_key"],
        ) =>
        {
            Err(ProviderKeyCheckError::InvalidKey)
        }
        402 | 403 => Err(ProviderKeyCheckError::NoAccess),
        // Only OpenAI's documented quota code: other 429s are rate limits.
        429 if mentions(body, &["insufficient_quota"]) => Err(ProviderKeyCheckError::NoAccess),
        429 => Err(ProviderKeyCheckError::RateLimited),
        404 | 405 => Ok(ProviderKeyCheck {
            models: Vec::new(),
            verified: false,
        }),
        _ => Err(ProviderKeyCheckError::ProviderUnavailable { status }),
    }
}

fn mentions(body: Option<&Value>, needles: &[&str]) -> bool {
    let text = body
        .map(Value::to_string)
        .unwrap_or_default()
        .to_lowercase();
    needles.iter().any(|needle| text.contains(needle))
}

/// Model ids of an OpenAI-style (`data[].id`) or Gemini-style
/// (`models[].name`, `models/` prefix removed) list.
fn model_ids(body: Option<&Value>) -> Vec<String> {
    let entries = body
        .and_then(|body| body.get("data").or_else(|| body.get("models")))
        .and_then(Value::as_array);
    entries
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            entry
                .get("id")
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)
        })
        .map(|id| id.strip_prefix("models/").unwrap_or(id).to_owned())
        .filter(|id| !id.is_empty())
        .take(MAX_LISTED_MODELS)
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Provider answers from each vendor's documented error shape.
    #[test]
    fn classifies_provider_answers_into_public_codes() {
        let cases: [(u16, Value, Result<bool, &str>); 10] = [
            (200, json!({"data":[{"id":"gpt-6-sol"}]}), Ok(true)),
            (
                401,
                json!({"error":{"code":"invalid_api_key"}}),
                Err("invalid_key"),
            ),
            (
                400,
                json!({"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}),
                Err("invalid_key"),
            ),
            (
                400,
                json!({"error":{"message":"bad field"}}),
                Err("provider_unavailable"),
            ),
            (
                403,
                json!({"error":{"status":"PERMISSION_DENIED"}}),
                Err("no_access"),
            ),
            (
                429,
                json!({"error":{"code":"insufficient_quota"}}),
                Err("no_access"),
            ),
            (
                429,
                json!({"error":{"code":"rate_limit_exceeded"}}),
                Err("rate_limited"),
            ),
            (
                429,
                json!({"error":{"message":"Tokens per minute quota reached"}}),
                Err("rate_limited"),
            ),
            (404, json!({}), Ok(false)),
            (503, json!({}), Err("provider_unavailable")),
        ];
        for (status, body, expected) in cases {
            let actual = classify(status, Some(&body))
                .map(|check| check.verified)
                .map_err(|error| error.code());
            assert_eq!(actual, expected, "{status} {body}");
        }
    }

    #[test]
    fn checking_and_saving_share_one_key_rule() {
        assert_eq!(
            provider_key("openai", "  sk-x \n")
                .map(|(_, key)| key)
                .map_err(|error| error.code()),
            Ok("sk-x")
        );
        for (provider, key, code) in [
            ("openai", "", "invalid_request"),
            ("openai", " \t ", "invalid_request"),
            ("openai", "sk-a\nb", "invalid_request"),
            ("local", "sk-x", "unsupported_provider"),
        ] {
            assert_eq!(
                provider_key(provider, key).map_err(|error| error.code()),
                Err(code),
                "{provider} {key:?}"
            );
        }
    }

    #[test]
    fn lists_openai_and_gemini_model_ids() {
        let openai = json!({"object":"list","data":[{"id":"gpt-6-sol"},{"id":"gpt-6-luna"}]});
        assert_eq!(model_ids(Some(&openai)), ["gpt-6-sol", "gpt-6-luna"]);
        let gemini = json!({"models":[{"name":"models/gemini-3.8-flash"}]});
        assert_eq!(model_ids(Some(&gemini)), ["gemini-3.8-flash"]);
        assert!(model_ids(None).is_empty());
    }
}
