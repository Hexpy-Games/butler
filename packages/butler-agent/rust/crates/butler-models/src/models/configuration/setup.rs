//! Model facts first-run setup (#230) reads and writes: saving a provider
//! key under a generated name, and who the saved ChatGPT sign-in belongs to.

use std::path::Path;

use serde_json::Value;

use super::super::{CredentialView, ModelCatalogError};
use super::key_check::{ProviderKeyCheckError, provider_key};
use super::{ModelConfiguration, auth, credentials, read_object_sync};

/// A key saved by first-run setup.
pub struct SavedProviderKey {
    pub credential: CredentialView,
    /// False when the provider already had this key and it was reused.
    pub created: bool,
}

/// Why a key was not saved. `Display` is the public message.
#[derive(Debug, thiserror::Error)]
pub enum ProviderKeySaveError {
    /// Unsupported provider or a malformed key (the key check's codes).
    #[error(transparent)]
    Invalid(#[from] ProviderKeyCheckError),
    /// The credentials file could not be written.
    #[error("The API key could not be saved.")]
    Storage(#[source] ModelCatalogError),
    /// The credentials owner refused the key; the message says why.
    #[error("{0}")]
    Rejected(#[source] ModelCatalogError),
}

impl ModelConfiguration {
    /// Saves `api_key` for `provider_id` under `root`, named `provider_id`,
    /// then `provider_id-2`, `-3`, ...; an identical saved key is reused.
    /// The lookup, the name and the write happen under the configuration
    /// write lock, so concurrent saves neither duplicate a key nor a name.
    pub async fn save_provider_key(
        &self,
        provider_id: &str,
        api_key: &str,
        root: &Path,
    ) -> Result<SavedProviderKey, ProviderKeySaveError> {
        let (provider, key) = provider_key(provider_id, api_key)?;
        let _write = self.configuration_writes.acquire().await;
        let path = root.join("auth/model-provider-credentials.json");
        let saved = credentials::read(
            &read_object_sync(&path),
            &self.registration_catalog,
            self.clock.as_ref(),
        );
        if let Some(existing) = saved
            .iter()
            .find(|record| record.provider_id == provider && record.secret == key)
        {
            return Ok(SavedProviderKey {
                credential: existing.view(),
                created: false,
            });
        }
        let views = saved.iter().map(credentials::CredentialRecord::view);
        let label = generated_label(&provider, &views.collect::<Vec<_>>());
        let credential = credentials::upsert(
            &path,
            &provider,
            key,
            Some(&label),
            None,
            &self.registration_catalog,
            self.clock.as_ref(),
        )
        .map_err(|error| match error {
            ModelCatalogError::Storage { .. } => ProviderKeySaveError::Storage(error),
            other => ProviderKeySaveError::Rejected(other),
        })?;
        Ok(SavedProviderKey {
            credential,
            created: true,
        })
    }

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

/// `provider_id`, then `provider_id-2`, `-3`, ...: the first name no saved
/// credential uses.
fn generated_label(provider_id: &str, saved: &[CredentialView]) -> String {
    let taken = |label: &str| saved.iter().any(|credential| credential.label == label);
    if !taken(provider_id) {
        return provider_id.to_owned();
    }
    // Among `saved.len() + 1` candidates at least one is free.
    (2..=saved.len() + 2)
        .map(|number| format!("{provider_id}-{number}"))
        .find(|label| !taken(label))
        .unwrap_or_else(|| provider_id.to_owned())
}

#[cfg(test)]
mod tests {
    use super::super::super::ProviderAuthMethod;
    use super::*;

    fn saved(label: &str) -> CredentialView {
        CredentialView {
            id: format!("cred_{label}"),
            provider_id: "openai".into(),
            auth_type: ProviderAuthMethod::ApiKey,
            label: label.into(),
            masked_value: "sk-...x".into(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn generated_names_count_up_from_the_provider_id() {
        assert_eq!(generated_label("openai", &[]), "openai");
        assert_eq!(generated_label("openai", &[saved("openai")]), "openai-2");
        assert_eq!(
            generated_label(
                "openai",
                &[saved("openai"), saved("openai-2"), saved("work")]
            ),
            "openai-3"
        );
    }
}
