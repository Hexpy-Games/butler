//! Model facts first-run setup (#230) reads and writes: saving a provider
//! key under a generated name, and who the saved ChatGPT sign-in belongs to.

use std::path::Path;

use serde_json::Value;

use super::super::{CredentialView, ModelCatalogError};
use super::credential_admin::CredentialDraft;
use super::credentials::{CREDENTIALS_FILE, CredentialRecord, CredentialsFile};
use super::key_check::{ProviderKeyCheckError, provider_key};
use super::mutations::catalog_error;
use super::{ModelConfiguration, auth};

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
        let mut file = CredentialsFile::load(&root.join(CREDENTIALS_FILE)).map_err(save_error)?;
        let saved = file.records(&self.registration_catalog, self.clock.as_ref());
        for record in saved.iter().filter(|record| record.provider_id == provider) {
            let same = self
                .credential_secret(root, record)
                .await
                .is_ok_and(|secret| secret.expose() == key);
            if same {
                return Ok(SavedProviderKey {
                    credential: record.view(),
                    created: false,
                });
            }
        }
        let views: Vec<CredentialView> = saved.iter().map(CredentialRecord::view).collect();
        let draft = CredentialDraft {
            id: format!("cred_{}", uuid::Uuid::new_v4()),
            label: generated_label(&provider, &views),
            provider_id: provider,
            created_at: self.clock.now_iso(),
        };
        let credential = self
            .write_credential(root, &mut file, draft, key, None)
            .await
            .map_err(|error| save_error(catalog_error(error)))?;
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

/// A storage failure is `Storage`; a refusal says why.
fn save_error(error: ModelCatalogError) -> ProviderKeySaveError {
    match error {
        ModelCatalogError::Storage { .. } => ProviderKeySaveError::Storage(error),
        other => ProviderKeySaveError::Rejected(other),
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
