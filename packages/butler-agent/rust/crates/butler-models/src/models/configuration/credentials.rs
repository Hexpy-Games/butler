//! Saved provider API keys (#217). `auth/model-provider-credentials.json`
//! (owner-only) keeps each key's id, provider, name, masked value,
//! fingerprint, store and dates; the key itself lives in a credential store
//! (`secret_store`). A record saved before #217 still carries its key as
//! `secret` until the start-up migration (`credential_migration`) moves it.
//!
//! The file also journals store entries still to be removed
//! (`pending_secret_removals`): a removal is written in the same atomic save
//! as the change that makes the entry unused, and is retried until it
//! succeeds, so neither a failure nor a crash leaves a key behind for good.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use butler_platform::secrets::{ChangeLock, SecretBackend, SecretText};
use butler_platform::secure_fs;
use serde_json::{Map, Value, json};

use super::super::catalog::{hosted_provider, normalize_display_label};
use super::super::{
    CredentialStorage, CredentialView, ModelCatalogError, ModelCatalogSnapshot, ProviderAuthMethod,
};
use super::{ModelConfigurationClock, array, first_by_key, text};

/// The credentials file, relative to the data root.
pub(super) const CREDENTIALS_FILE: &str = "auth/model-provider-credentials.json";

/// The journal field of store entries still to be removed.
const PENDING: &str = "pending_secret_removals";

/// How long a change waits for another process's change to finish.
const CHANGE_WAIT: Duration = Duration::from_secs(10);

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
    /// See `secret_store::fingerprint`; absent on keys saved before it.
    pub(super) fingerprint: Option<String>,
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
        let fields = butler_core::json::object_mut(&mut value);
        match &self.home {
            SecretHome::Plaintext(secret) => fields.insert("secret".into(), secret.expose().into()),
            SecretHome::Store(backend) => fields.insert("storage".into(), backend.as_str().into()),
        };
        if let Some(fingerprint) = &self.fingerprint {
            fields.insert("fingerprint".into(), fingerprint.as_str().into());
        }
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

/// The record an entry describes, when this version can use it.
pub(super) fn record(
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
        fingerprint: text(value.get("fingerprint")).map(str::to_owned),
        home,
        created_at: date("created_at"),
        updated_at: date("updated_at"),
        provider_id,
    })
}

/// A store entry still to be removed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PendingRemoval {
    pub(super) backend: SecretBackend,
    pub(super) provider_id: String,
    pub(super) id: String,
}

/// The credentials file as stored, for a change that keeps every entry it
/// does not touch (including entries this version cannot use) and every
/// other field of the document.
#[derive(Clone, Default)]
pub(super) struct CredentialsFile {
    document: Map<String, Value>,
    entries: Vec<Value>,
}

impl CredentialsFile {
    /// Takes the cross-process change lock of the file at `path` (see
    /// [`ChangeLock`]); hold it from [`Self::load`] to [`Self::save`].
    pub(super) async fn lock(path: &Path) -> Result<ChangeLock, ModelCatalogError> {
        let mut name = path.as_os_str().to_owned();
        name.push(".lock");
        let lock = PathBuf::from(name);
        tokio::task::spawn_blocking(move || ChangeLock::acquire(&lock, CHANGE_WAIT))
            .await
            .map_err(|error| storage("The saved API keys are busy.", error))?
            .map_err(|error| storage("The saved API keys are busy.", error))
    }

    /// The file at `path`; empty when it does not exist. It is opened
    /// without following a symbolic link and must be UTF-8 JSON of the
    /// credentials shape; otherwise it is an error (and the file is made
    /// owner-only, as it may hold keys), so a change never replaces what it
    /// could not read.
    pub(super) fn load(path: &Path) -> Result<Self, ModelCatalogError> {
        let mut file = match secure_fs::open_read_no_follow(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(error) => return Err(storage("The saved API keys could not be read.", error)),
        };
        secure_fs::restrict_file(path)
            .transpose()
            .map_err(|error| storage("The saved API keys could not be protected.", error))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| storage("The saved API keys could not be read.", error))?;
        Self::parse(&bytes).inspect_err(|_| {
            let _ = secure_fs::restrict_file(path);
        })
    }

    fn parse(bytes: &[u8]) -> Result<Self, ModelCatalogError> {
        let text = std::str::from_utf8(bytes)
            .map_err(|error| storage("The saved API keys file is not UTF-8.", error))?;
        let value: Value = serde_json::from_str(text)
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
    pub(super) fn entries(&self) -> &[Value] {
        &self.entries
    }

    /// The raw entries, in order, to change.
    pub(super) fn entries_mut(&mut self) -> &mut Vec<Value> {
        &mut self.entries
    }

    /// Writes `record` as the only entry of its id: replaces the first and
    /// drops any later duplicate (which might still hold an old key).
    pub(super) fn put(&mut self, record: &CredentialRecord) {
        let value = record.to_json();
        match position(&self.entries, &record.id) {
            Some(index) => {
                self.entries[index] = value;
                let mut seen = 0;
                self.entries.retain(|entry| {
                    let duplicate = text(entry.get("id")) == Some(record.id.as_str());
                    seen += usize::from(duplicate);
                    !duplicate || seen == 1
                });
            }
            None => self.entries.push(value),
        }
    }

    /// Removes every entry of `id`.
    pub(super) fn remove(&mut self, id: &str) -> bool {
        let before = self.entries.len();
        self.entries
            .retain(|entry| text(entry.get("id")) != Some(id));
        self.entries.len() != before
    }

    /// Journals the removal of `provider_id/id` from `backend` (saved with
    /// the next [`Self::save`]).
    pub(super) fn schedule_removal(&mut self, removal: &PendingRemoval) {
        if !self.pending_removals().contains(removal) {
            let entry = json!({
                "storage": removal.backend.as_str(),
                "provider_id": removal.provider_id,
                "id": removal.id,
            });
            match self.document.get_mut(PENDING) {
                Some(Value::Array(pending)) => pending.push(entry),
                _ => {
                    self.document
                        .insert(PENDING.into(), Value::Array(vec![entry]));
                }
            }
        }
    }

    /// The journaled removals.
    pub(super) fn pending_removals(&self) -> Vec<PendingRemoval> {
        array(self.document.get(PENDING))
            .iter()
            .filter_map(|entry| {
                Some(PendingRemoval {
                    backend: SecretBackend::from_name(entry.get("storage")?.as_str()?)?,
                    provider_id: text(entry.get("provider_id"))?.to_owned(),
                    id: text(entry.get("id"))?.to_owned(),
                })
            })
            .collect()
    }

    /// Drops `done` from the journal (the field goes when it is empty).
    pub(super) fn finish_removals(&mut self, done: &[PendingRemoval]) {
        let remaining: Vec<Value> = self
            .pending_removals()
            .into_iter()
            .filter(|removal| !done.contains(removal))
            .map(|removal| {
                json!({
                    "storage": removal.backend.as_str(),
                    "provider_id": removal.provider_id,
                    "id": removal.id,
                })
            })
            .collect();
        if remaining.is_empty() {
            self.document.remove(PENDING);
        } else {
            self.document
                .insert(PENDING.into(), Value::Array(remaining));
        }
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
