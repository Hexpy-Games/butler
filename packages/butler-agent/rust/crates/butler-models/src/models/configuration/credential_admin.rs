//! Managing saved provider API keys (#217): the list (masked, with each
//! key's store and the models that use it, and where new keys go and why),
//! replacing a key and deleting one. A key is named by its credential id
//! or, when no id matches, by its label if exactly one key has it.
//!
//! Deleting follows one rule: a key the default model uses is never deleted
//! (choose another default first); a key other registered models use is
//! deleted only with `force`, which unregisters those models too. The record
//! goes first (its store entry journaled for removal), then the models; if
//! unregistering fails the record is restored, and the store entry is
//! removed only once both succeeded.

use std::path::Path;

use butler_platform::secrets::{SYSTEM_BACKEND, SecretStoreMode};
use serde::Serialize;
use serde_json::Value;

use super::credentials::{CREDENTIALS_FILE, CredentialRecord, PendingRemoval, SecretHome};
use super::key_check::{ProviderKeyCheckError, provider_key};
use super::mutations::{normalized_registered, set_models_array, write_json};
use super::secret_store::CredentialStoreError;
use super::store_policy::{FileOverride, StoreReason};
use super::{ModelConfiguration, read_object_sync};
use crate::models::{
    CredentialStorage, CredentialView, ModelCatalogError, ProviderAuthMethod,
    RegisteredHostedModelConfig, parse_model_ref,
};

/// Why a key operation failed. `Display` is the public message; it never
/// contains a key.
#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("No saved API key has this name.")]
    NotFound,
    #[error("More than one saved API key has this name. Use its id.")]
    Ambiguous,
    /// The default model uses the key.
    #[error("The default model uses this API key. Choose another default model first.")]
    InUseByDefault { model_refs: Vec<String> },
    /// Registered models use the key; `force` also unregisters them.
    #[error("{} registered model(s) use this API key. Delete with force to remove them too.", model_refs.len())]
    InUse { model_refs: Vec<String> },
    /// The key is malformed, or its provider rejected it (`verify`).
    #[error(transparent)]
    Check(#[from] ProviderKeyCheckError),
    /// The key's store failed, refused access or is unavailable.
    #[error("The API key could not be kept in the credential store.")]
    Store(#[source] CredentialStoreError),
    /// The record names a store entry that is gone.
    #[error("The saved API key is missing from the credential store. Replace it.")]
    SecretMissing,
    /// The credentials or configuration file could not be read or written.
    #[error(transparent)]
    File(#[from] ModelCatalogError),
}

impl CredentialError {
    /// The stable public error code.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "credential_not_found",
            Self::Ambiguous => "credential_ambiguous",
            Self::InUseByDefault { .. } => "credential_in_use_by_default",
            Self::InUse { .. } => "credential_in_use",
            Self::Check(error) => error.code(),
            Self::Store(error) => error.code(),
            Self::SecretMissing => "credential_secret_missing",
            Self::File(ModelCatalogError::Rejected(_)) => "credential_file_invalid",
            Self::File(_) => "credential_file_failed",
        }
    }
}

impl From<CredentialStoreError> for CredentialError {
    fn from(error: CredentialStoreError) -> Self {
        Self::Store(error)
    }
}

/// `GET /credentials`: the saved keys, masked, and where new keys go.
#[derive(Clone, Serialize)]
pub struct CredentialList {
    pub credentials: Vec<CredentialListItem>,
    pub store: CredentialStoreView,
}

/// A saved key and the registered models that use it.
#[derive(Clone, Serialize)]
pub struct CredentialListItem {
    #[serde(flatten)]
    pub credential: CredentialView,
    pub model_refs: Vec<String>,
}

/// Where new and replaced keys go, and why.
#[derive(Clone, Debug, Serialize)]
pub struct CredentialStoreView {
    /// The store new keys are written to.
    pub backend: CredentialStorage,
    /// Why: `unsigned_build`, `signed_build`, `config` or `test_override`.
    pub reason: StoreReason,
    /// Why the owner-only file is used although the system store was
    /// chosen (it does not exist on this host).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<&'static str>,
    /// The system store was chosen but failed or refused access: new keys
    /// cannot be saved until it answers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
    /// `BUTLER_SECRET_STORE=file` was ignored for the user's own data folder.
    pub override_ignored: bool,
    /// Keys still in the credentials file as plain text.
    pub legacy_plaintext: usize,
}

/// `DELETE /credentials/{name}`.
#[derive(Clone, Serialize)]
pub struct DeletedCredential {
    pub credential: CredentialView,
    /// Models unregistered with the key (`force`).
    pub removed_model_refs: Vec<String>,
    /// False when the store entry is not removed yet: it stays journaled and
    /// is retried (the record is gone either way).
    pub secret_removed: bool,
}

/// The fields of a key being saved; the key itself is passed apart.
pub(super) struct CredentialDraft {
    pub(super) id: String,
    pub(super) provider_id: String,
    pub(super) label: String,
    pub(super) created_at: String,
}

impl CredentialDraft {
    fn of(record: &CredentialRecord) -> Self {
        Self {
            id: record.id.clone(),
            provider_id: record.provider_id.clone(),
            label: record.label.clone(),
            created_at: record.created_at.clone(),
        }
    }
}

impl ModelConfiguration {
    /// The saved keys under `root` (masked, from the credentials file only:
    /// no key is read) and where new keys go.
    pub async fn list_provider_credentials(
        &self,
        root: &Path,
    ) -> Result<CredentialList, CredentialError> {
        let records = self.saved_credentials(root);
        let config = read_object_sync(&root.join("butler.config.json"));
        let registered = normalized_registered(&config, self, &self.clock.now_iso());
        let mut store = self.store_view(root).await;
        store.legacy_plaintext = records
            .iter()
            .filter(|record| matches!(record.home, SecretHome::Plaintext(_)))
            .count();
        let credentials = records
            .iter()
            .map(|record| CredentialListItem {
                credential: record.view(),
                model_refs: users(&registered, record)
                    .map(|model| model.model_ref.clone())
                    .collect(),
            })
            .collect();
        Ok(CredentialList { credentials, store })
    }

    /// Where new keys go under `root` (opens the system store when the
    /// policy picks it).
    async fn store_view(&self, root: &Path) -> CredentialStoreView {
        let override_ignored =
            self.secrets.facts().file_override == FileOverride::IgnoredForDefaultDataRoot;
        let choice = self.secrets.choice(root);
        let mut view = CredentialStoreView {
            backend: CredentialStorage::FallbackFile,
            reason: choice.reason,
            fallback_reason: None,
            error: None,
            override_ignored,
            legacy_plaintext: 0,
        };
        if choice.mode == SecretStoreMode::System {
            match self.secrets.target(root).await {
                Ok(target) => {
                    view.backend = target.store.backend().into();
                    view.fallback_reason =
                        target.fallback.as_deref().map(CredentialStoreError::code);
                }
                Err(error) => {
                    view.backend = SYSTEM_BACKEND.into();
                    view.error = Some(error.code());
                }
            }
        }
        view
    }

    /// Replaces the key of the saved credential `name`; its id, name and
    /// models stay. With `verify`, the provider checks the new key first and
    /// a rejected key changes nothing.
    pub async fn replace_provider_credential(
        &self,
        name: &str,
        api_key: &str,
        verify: bool,
        root: &Path,
    ) -> Result<CredentialView, CredentialError> {
        if verify {
            let provider = find(&self.saved_credentials(root), name)?
                .provider_id
                .clone();
            self.check_provider_key(&provider, api_key).await?;
        }
        let _write = self.configuration_writes.acquire().await;
        let (_lock, mut file) = self.open_credentials(root).await?;
        let records = file.records(&self.registration_catalog, self.clock.as_ref());
        let record = find(&records, name)?;
        let (_, key) = provider_key(&record.provider_id, api_key)?;
        self.write_credential(
            root,
            &mut file,
            CredentialDraft::of(record),
            key,
            Some(&record.home),
        )
        .await
    }

    /// Deletes the saved credential `name` and its key (see the module
    /// documentation for keys that models use, and for the order).
    pub async fn delete_provider_credential(
        &self,
        name: &str,
        force: bool,
        root: &Path,
    ) -> Result<DeletedCredential, CredentialError> {
        let _write = self.configuration_writes.acquire().await;
        let (_lock, mut file) = self.open_credentials(root).await?;
        let records = file.records(&self.registration_catalog, self.clock.as_ref());
        let record = find(&records, name)?;
        let config_path = root.join("butler.config.json");
        let mut config = read_object_sync(&config_path);
        let removed_model_refs = release_models(self, &mut config, record, force)?;
        let backup = file.clone();
        file.remove(&record.id);
        let removal = match record.home {
            SecretHome::Plaintext(_) => None,
            SecretHome::Store(backend) => Some(PendingRemoval {
                backend,
                provider_id: record.provider_id.clone(),
                id: record.id.clone(),
            }),
        };
        if let Some(removal) = &removal {
            file.schedule_removal(removal);
        }
        let path = root.join(CREDENTIALS_FILE);
        file.save(&path)?;
        if !removed_model_refs.is_empty()
            && let Err(error) = write_json(&config_path, &config)
        {
            let _ = backup.save(&path);
            return Err(error.into());
        }
        self.flush_removals(root, &mut file).await;
        let secret_removed =
            removal.is_none_or(|removal| !file.pending_removals().contains(&removal));
        Ok(DeletedCredential {
            credential: record.view(),
            removed_model_refs,
            secret_removed,
        })
    }

    /// The saved credentials under `root`, read leniently (a damaged file
    /// lists nothing).
    pub(super) fn saved_credentials(&self, root: &Path) -> Vec<CredentialRecord> {
        super::credentials::read(
            &read_object_sync(&root.join(CREDENTIALS_FILE)),
            &self.registration_catalog,
            self.clock.as_ref(),
        )
    }
}

/// Refuses a key the default model uses, and one other models use unless
/// `force`; with `force`, drops those models from `config` (the caller
/// writes it). Returns the models that use the key.
fn release_models(
    owner: &ModelConfiguration,
    config: &mut Value,
    record: &CredentialRecord,
    force: bool,
) -> Result<Vec<String>, CredentialError> {
    let registered = normalized_registered(config, owner, &owner.clock.now_iso());
    let using: Vec<&RegisteredHostedModelConfig> = users(&registered, record).collect();
    let model_refs: Vec<String> = using.iter().map(|model| model.model_ref.clone()).collect();
    if using.iter().any(|model| is_default(config, model)) {
        return Err(CredentialError::InUseByDefault { model_refs });
    }
    if using.is_empty() {
        return Ok(model_refs);
    }
    if !force {
        return Err(CredentialError::InUse { model_refs });
    }
    let remaining: Vec<&RegisteredHostedModelConfig> = registered
        .iter()
        .filter(|model| !model_refs.contains(&model.model_ref))
        .collect();
    let remaining = serde_json::to_value(remaining).map_err(ModelCatalogError::from)?;
    set_models_array(config, "registered", remaining);
    Ok(model_refs)
}

/// The saved credential `name`: the one with this id, else the only one
/// with this label.
fn find<'a>(
    records: &'a [CredentialRecord],
    name: &str,
) -> Result<&'a CredentialRecord, CredentialError> {
    let name = butler_core::public_text::trim_js_whitespace(name);
    if let Some(record) = records.iter().find(|record| record.id == name) {
        return Ok(record);
    }
    let mut labelled = records.iter().filter(|record| record.label == name);
    match (labelled.next(), labelled.next()) {
        (Some(record), None) => Ok(record),
        (Some(_), Some(_)) => Err(CredentialError::Ambiguous),
        (None, _) => Err(CredentialError::NotFound),
    }
}

/// The registered models that authenticate with `record`.
fn users<'a>(
    registered: &'a [RegisteredHostedModelConfig],
    record: &'a CredentialRecord,
) -> impl Iterator<Item = &'a RegisteredHostedModelConfig> {
    registered.iter().filter(|model| {
        model.auth_type == ProviderAuthMethod::ApiKey
            && model.provider_id == record.provider_id
            && model.credential_id.as_deref() == Some(record.id.as_str())
    })
}

/// Whether `model` is the configured default model (either setting).
fn is_default(config: &Value, model: &RegisteredHostedModelConfig) -> bool {
    ["/system/butlerModel", "/system/defaultModel"]
        .iter()
        .filter_map(|pointer| config.pointer(pointer).and_then(Value::as_str))
        .map(|value| parse_model_ref(value).canonical_ref)
        .any(|value| value == model.model_ref)
}
