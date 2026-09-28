//! Model facts first-run setup reads (#230): whether a key is already
//! saved, and who the saved ChatGPT sign-in belongs to.

use serde_json::Value;

use super::super::CredentialView;
use super::{ModelConfiguration, ModelConfigurationRead, auth};

impl ModelConfigurationRead {
    /// The saved credential of `provider_id` whose secret is `secret`
    /// (surrounding whitespace ignored), so saving the same key twice
    /// reuses it. Only the masked view leaves this owner.
    pub fn credential_with_secret(
        &self,
        provider_id: &str,
        secret: &str,
    ) -> Option<CredentialView> {
        let secret = butler_core::public_text::trim_js_whitespace(secret);
        self.credentials
            .iter()
            .find(|record| record.provider_id == provider_id && record.secret == secret)
            .map(super::credentials::CredentialRecord::view)
    }
}

impl ModelConfiguration {
    /// The account label of the saved ChatGPT (Codex subscription) sign-in:
    /// its email, else its account id, else a generic label. `None` when
    /// there is no saved sign-in.
    pub async fn openai_auth_profile_label(&self) -> Option<String> {
        let profile = auth::AuthOwner {
            data_root: &self.data_root,
            environment: &self.environment,
            clock: self.clock.as_ref(),
            client: &self.client,
        }
        .read_butler_profile()
        .await?;
        let raw = profile.as_json();
        Some(
            ["email", "accountId"]
                .iter()
                .find_map(|key| raw.get(*key).and_then(Value::as_str))
                .filter(|value| !value.is_empty())
                .unwrap_or("OpenAI account")
                .to_owned(),
        )
    }
}
