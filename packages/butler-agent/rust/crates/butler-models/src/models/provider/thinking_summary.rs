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
        ProviderAuth::Codex {
            authorization,
            account_id,
            ..
        } => {
            hash.update(authorization.as_bytes());
            hash.update([0]);
            hash.update(account_id.as_bytes());
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
