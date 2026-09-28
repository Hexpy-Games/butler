//! Saved provider API keys (#217). `auth/model-provider-credentials.json`
//! (owner-only) keeps each key's id, provider, name, masked value, store and
//! dates; the key itself lives in a credential store (`secret_store`). A
//! record saved before #217 still carries its key as `secret` until the
//! start-up migration (`credential_migration`) moves it.

use std::io::Write;
use std::path::Path;

use butler_platform::secrets::{SecretBackend, SecretText};
use butler_platform::secure_fs;
use serde_json::{Map, Value, json};

use super::super::catalog::{hosted_provider, normalize_display_label};
use super::super::{
    CredentialStorage, CredentialView, ModelCatalogError, ModelCatalogSnapshot, ProviderAuthMethod,
};
use super::{ModelConfigurationClock, array, first_by_key, text};

/// The credentials file, relative to the data root.
pub(super) const CREDENTIALS_FILE: &str = "auth/model-provider-credentials.json";

/// Where a record's key is.
pub(super) enum SecretHome {
    /// In the credentials file as plain text: saved before #217 and not
    /// moved yet.
    Plaintext(SecretText),
    /// In this store, under `<provider>/<id>`.
    Store(SecretBackend),
}

/// One saved key's metadata (and, before its move, the key).
pub(super) struct CredentialRecord {
    pub(super) id: String,
    pub(super) provider_id: String,
    pub(super) label: String,
    pub(super) masked_value: String,
    pub(super) home: SecretHome,
    pub(super) created_at: String,
    pub(super) updated_at: String,
}

impl CredentialRecord {
    pub(super) fn storage(&self) -> CredentialStorage {
        match self.home {
            SecretHome::Plaintext(_) => CredentialStorage::LegacyPlaintext,
            SecretHome::Store(backend) => backend.into(),
        }
    }

    pub(super) fn view(&self) -> CredentialView {
        CredentialView {
            id: self.id.clone(),
            provider_id: self.provider_id.clone(),
            auth_type: ProviderAuthMethod::ApiKey,
            label: self.label.clone(),
            masked_value: self.masked_value.clone(),
            storage: self.storage(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }

    /// The stored form: never the key once it is in a store.
    fn to_json(&self) -> Value {
        let mut value = json!({
            "id": self.id,
            "provider_id": self.provider_id,
            "auth_type": "api_key",
            "label": self.label,
            "masked_value": self.masked_value,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        });
        let (field, content) = match &self.home {
            SecretHome::Plaintext(secret) => ("secret", secret.expose()),
            SecretHome::Store(backend) => ("storage", backend.as_str()),
        };
        butler_core::json::object_mut(&mut value).insert(field.into(), content.into());
        value
    }
}

/// The public form of a key: its first three UTF-16 units, `...`, its last
/// character.
pub(super) fn mask(secret: &str) -> String {
    let prefix: String = secret
        .chars()
        .scan(0, |units, character| {
            *units += character.len_utf16();
            (*units <= 3).then_some(character)
        })
        .collect();
    let suffix = secret
        .chars()
        .last()
        .map(|value| value.to_string())
        .unwrap_or_default();
    format!("{prefix}...{suffix}")
}

/// The usable records of a credentials document, the first of each id.
pub(super) fn read(
    value: &Value,
    catalog: &ModelCatalogSnapshot,
    clock: &dyn ModelConfigurationClock,
) -> Vec<CredentialRecord> {
    first_by_key(
        array(value.get("credentials"))
            .iter()
            .filter_map(|value| record(value, catalog, clock)),
        |record| record.id.clone(),
    )
}

fn record(
    value: &Value,
    catalog: &ModelCatalogSnapshot,
    clock: &dyn ModelConfigurationClock,
) -> Option<CredentialRecord> {
    let provider_id = hosted_provider(value.get("provider_id")?.as_str()?)?;
    if value.get("auth_type").and_then(Value::as_str) != Some("api_key") {
        return None;
    }
    let id = text(value.get("id"))?.to_owned();
    let (home, masked) = if let Some(secret) = text(value.get("secret")) {
        let masked = mask(secret);
        (
            SecretHome::Plaintext(SecretText::new(secret.into())),
            masked,
        )
    } else {
        let backend = value
            .get("storage")
            .and_then(Value::as_str)
            .and_then(SecretBackend::from_name)?;
        (SecretHome::Store(backend), "...".to_owned())
    };
    let now = clock.now_iso();
    let provider_label = catalog
        .view()
        .models
        .iter()
        .find(|model| model.provider_id == provider_id)
        .map(|model| model.provider_label.as_str())
        .unwrap_or(&provider_id);
    let date = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or(&now)
            .to_owned()
    };
    Some(CredentialRecord {
        id,
        label: normalize_display_label(value.get("label"), provider_label),
        masked_value: text(value.get("masked_value")).map_or(masked, str::to_owned),
        home,
        created_at: date("created_at"),
        updated_at: date("updated_at"),
        provider_id,
    })
}

/// The credentials file as stored, for a change that keeps every entry it
/// does not touch (including entries this version cannot use) and every
/// other field of the document.
#[derive(Default)]
pub(super) struct CredentialsFile {
    document: Map<String, Value>,
    entries: Vec<Value>,
}

impl CredentialsFile {
    /// The file at `path`; empty when it does not exist. A file that cannot
    /// be read or is not a credentials document is an error, so a change
    /// never replaces what it could not read.
    pub(super) fn load(path: &Path) -> Result<Self, ModelCatalogError> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(error) => return Err(storage("The saved API keys could not be read.", error)),
        };
        let value: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes))
            .map_err(|error| storage("The saved API keys file is not valid JSON.", error))?;
        let Value::Object(mut document) = value else {
            return Err(unknown_shape());
        };
        let entries = match document.remove("credentials") {
            None => Vec::new(),
            Some(Value::Array(entries)) => entries,
            Some(_) => return Err(unknown_shape()),
        };
        Ok(Self { document, entries })
    }

    /// The whole document, as stored.
    pub(super) fn document(&self) -> Value {
        let mut document = self.document.clone();
        document.insert("credentials".into(), Value::Array(self.entries.clone()));
        Value::Object(document)
    }

    pub(super) fn records(
        &self,
        catalog: &ModelCatalogSnapshot,
        clock: &dyn ModelConfigurationClock,
    ) -> Vec<CredentialRecord> {
        read(&self.document(), catalog, clock)
    }

    /// The raw entries, in order.
    pub(super) fn entries_mut(&mut self) -> &mut Vec<Value> {
        &mut self.entries
    }

    /// Replaces the entry of `record`'s id (the first, as [`read`] uses), or
    /// adds one.
    pub(super) fn put(&mut self, record: &CredentialRecord) {
        let value = record.to_json();
        match position(&self.entries, &record.id) {
            Some(index) => self.entries[index] = value,
            None => self.entries.push(value),
        }
    }

    /// Removes the entry of `id` (the first, as [`read`] uses).
    pub(super) fn remove(&mut self, id: &str) -> bool {
        position(&self.entries, id)
            .map(|index| self.entries.remove(index))
            .is_some()
    }

    /// Replaces the file atomically; the file and a folder it creates are
    /// only the owner's.
    pub(super) fn save(&self, path: &Path) -> Result<(), ModelCatalogError> {
        let written = "The saved API keys could not be written.";
        let parent = path
            .parent()
            .ok_or_else(|| ModelCatalogError::rejected(written))?;
        secure_fs::create_private_dir_all(parent).map_err(|error| storage(written, error))?;
        let mut bytes =
            serde_json::to_vec_pretty(&self.document()).map_err(|error| storage(written, error))?;
        bytes.push(b'\n');
        secure_fs::replace_private(path, |file| file.write_all(&bytes), std::convert::identity)
            .map_err(|error| storage(written, error))
    }
}

fn position(entries: &[Value], id: &str) -> Option<usize> {
    entries
        .iter()
        .position(|entry| text(entry.get("id")) == Some(id))
}

fn unknown_shape() -> ModelCatalogError {
    ModelCatalogError::rejected("The saved API keys file has an unknown shape.")
}

fn storage(
    message: &'static str,
    source: impl Into<Box<dyn std::error::Error + Send + Sync>>,
) -> ModelCatalogError {
    ModelCatalogError::Storage {
        message,
        source: source.into(),
    }
}
