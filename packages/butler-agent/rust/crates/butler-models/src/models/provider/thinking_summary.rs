//! Credential-scoped, process-local opt-out of the optional OpenAI summary field.
use super::{ProviderAuth, ProviderRequestConfig};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Default)]
pub(super) struct Summaries(Mutex<HashSet<[u8; 32]>>);
impl Summaries {
    pub(super) fn supported(&self, config: &ProviderRequestConfig) -> bool {
        !self.0.lock().contains(&key(config))
    }
    pub(super) fn refuse(&self, config: &ProviderRequestConfig) {
        self.0.lock().insert(key(config));
    }
}
fn key(config: &ProviderRequestConfig) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(config.endpoint.as_str());
    hash.update([0]);
    match &config.auth {
        ProviderAuth::None => hash.update(b"none"),
        ProviderAuth::ApiKey(secret) => hash.update(secret.as_bytes()),
        ProviderAuth::ChatGptPlan {
            authorization,
            registration,
            ..
        } => {
            hash.update(authorization.as_bytes());
            hash.update([0]);
            hash.update(registration.as_bytes());
        }
    }
    hash.finalize().into()
}
pub(super) fn rejected(error: &butler_turn::btcc::ProviderRequestError) -> bool {
    error.status_code == Some(400)
        && error
            .provider_error_details
            .as_deref()
            .and_then(|details| details["param"].as_str())
            == Some("reasoning.summary")
}
pub(super) fn requested(body: &serde_json::Value, provider: &str) -> bool {
    match provider {
        "openai" => body["reasoning"]["summary"] == "auto",
        "google" => body["generationConfig"]["thinkingConfig"]["includeThoughts"] == true,
        "anthropic" => body["thinking"]["display"] == "summarized",
        _ => false,
    }
}

/// Extract provider summaries only; never expose raw reasoning.
pub(super) fn extract(
    response: Option<&serde_json::Value>,
    carrier: super::serialize::Carrier,
) -> Option<String> {
    let value = response?;
    let parts = match carrier {
        super::serialize::Carrier::Responses => value["output"]
            .as_array()?
            .iter()
            .filter(|v| v["type"] == "reasoning")
            .flat_map(|v| v["summary"].as_array().into_iter().flatten())
            .filter(|v| v["type"] == "summary_text")
            .filter_map(|v| v["text"].as_str())
            .collect::<Vec<_>>(),
        super::serialize::Carrier::Anthropic => value["content"]
            .as_array()?
            .iter()
            .filter(|v| v["type"] == "thinking")
            .filter_map(|v| v["thinking"].as_str())
            .collect(),
        super::serialize::Carrier::Gemini => value
            .pointer("/candidates/0/content/parts")?
            .as_array()?
            .iter()
            .filter(|v| v["thought"].as_bool() == Some(true))
            .filter_map(|v| v["text"].as_str())
            .collect(),
        super::serialize::Carrier::Chat { .. } => return None,
    };
    let mut body = String::new();
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 && matches!(carrier, super::serialize::Carrier::Responses) {
            let remaining = (64 * 1024usize).saturating_sub(body.len());
            body.push_str(&"\n\n"[..remaining.min(2)]);
        }
        let remaining = (64 * 1024usize).saturating_sub(body.len());
        let mut end = part.len().min(remaining);
        while !part.is_char_boundary(end) {
            end -= 1;
        }
        body.push_str(&part[..end]);
    }
    (!body.trim().is_empty()).then_some(body)
}
