//! The start-up move of saved API keys into the credential store (#217).
//!
//! Every credentials entry that still holds its key as plain text (saved
//! before #217), and every entry in the fallback file once the system store
//! is available, is written to the store where new keys go and read back;
//! only then is the entry rewritten without the key (one atomic, owner-only
//! rewrite for the whole file). An entry whose move fails keeps its key in
//! place and is retried at the next start: nothing is ever lost, and running
//! the move again changes nothing.

use std::collections::HashSet;
use std::path::Path;

use butler_platform::secrets::{
    SecretBackend, SecretKey, SecretStore, SecretStoreMode, SecretText,
};
use butler_platform::secure_fs;
use serde::Serialize;
use serde_json::Value;

use super::credentials::{CREDENTIALS_FILE, CredentialsFile, mask};
use super::secret_store::{self, CredentialStoreError, TargetStore};
use super::{ModelConfiguration, read_object_sync, text};
use crate::models::{CredentialStorage, ModelCatalogError};

/// What one start-up move did.
#[derive(Clone, Debug, Serialize)]
pub struct CredentialMigrationReport {
    /// The store keys were moved to; `None` when no entry had a key to
    /// move (no store was opened).
    pub backend: Option<CredentialStorage>,
    /// Why the system store was not used, when it was asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<&'static str>,
    /// Entries moved.
    pub moved: usize,
    /// Entries left in place, to be retried at the next start.
    pub failed: Vec<CredentialMigrationFailure>,
}

/// An entry the move left in place.
#[derive(Clone, Debug, Serialize)]
pub struct CredentialMigrationFailure {
    pub credential_id: String,
    pub code: &'static str,
}

impl CredentialMigrationReport {
    /// One structured log line (never a key), or `None` when there was
    /// nothing to move.
    pub fn log_line(&self) -> Option<String> {
        let backend = self.backend?;
        let failed = self
            .failed
            .iter()
            .map(|failure| format!("{}:{}", failure.credential_id, failure.code))
            .collect::<Vec<_>>()
            .join(",");
        Some(format!(
            "[native-credentials] migration backend={} moved={} failed={} fallback_reason={} failures={}",
            credential_storage_name(backend),
            self.moved,
            self.failed.len(),
            self.fallback_reason.unwrap_or("none"),
            if failed.is_empty() { "none" } else { &failed },
        ))
    }
}

/// The saved keys file as `butler doctor` reports it, read without touching
/// any credential store.
#[derive(Clone, Debug, Default, Serialize)]
pub struct CredentialFileSummary {
    /// Whether the credentials file exists.
    pub present: bool,
    /// Whether the file is only its owner's; `None` where the host has no
    /// owner-only permissions or the file is absent.
    pub owner_only: Option<bool>,
    /// Entries per store (`keychain`, ..., `legacy_plaintext`).
    pub storage: std::collections::BTreeMap<String, usize>,
    /// Entries still holding their key as plain text.
    pub legacy_plaintext: usize,
}

/// Summarizes `data_root`'s credentials file (read-only).
pub fn credential_file_summary(data_root: &Path) -> CredentialFileSummary {
    let path = data_root.join(CREDENTIALS_FILE);
    let Ok(metadata) = std::fs::metadata(&path) else {
        return CredentialFileSummary::default();
    };
    let mut summary = CredentialFileSummary {
        present: true,
        owner_only: secure_fs::is_owner_only(&metadata),
        ..CredentialFileSummary::default()
    };
    let document = read_object_sync(&path);
    for entry in super::array(document.get("credentials")) {
        let storage = if text(entry.get("secret")).is_some() {
            summary.legacy_plaintext += 1;
            "legacy_plaintext".to_owned()
        } else {
            text(entry.get("storage")).unwrap_or("unknown").to_owned()
        };
        *summary.storage.entry(storage).or_default() += 1;
    }
    summary
}

/// Where one entry's key comes from.
enum Source {
    Plaintext(SecretText),
    File(SecretStore),
}

/// What happened to one entry.
enum Outcome {
    Untouched,
    Moved {
        entry: Value,
        from_file: Option<(SecretStore, SecretKey)>,
    },
    Failed(CredentialMigrationFailure),
}

impl ModelConfiguration {
    /// Moves every movable key of the data root into the store where new
    /// keys go (see the module documentation). Runs once at service start,
    /// under the configuration write lock.
    pub async fn migrate_provider_credentials(
        &self,
    ) -> Result<CredentialMigrationReport, ModelCatalogError> {
        let _write = self.configuration_writes.acquire().await;
        let root = self.data_root.as_path();
        let path = root.join(CREDENTIALS_FILE);
        let mut file = CredentialsFile::load(&path)?;
        let upgrade = self.secrets.mode() == SecretStoreMode::System;
        let movable = file.entries_mut().iter().any(|entry| {
            text(entry.get("secret")).is_some()
                || (upgrade
                    && text(entry.get("storage")) == Some(SecretBackend::FallbackFile.as_str()))
        });
        let mut report = CredentialMigrationReport {
            backend: None,
            fallback_reason: None,
            moved: 0,
            failed: Vec::new(),
        };
        if !movable {
            if path.exists() {
                let _ = secure_fs::restrict_file(&path);
            }
            return Ok(report);
        }
        let target = self.secrets.target(root).await;
        report.backend = Some(target.store.backend().into());
        report.fallback_reason = target.fallback.as_deref().map(CredentialStoreError::code);
        let mut seen = HashSet::new();
        let mut cleanup = Vec::new();
        for index in 0..file.entries_mut().len() {
            let entry = file.entries_mut()[index].clone();
            match migrate_entry(root, &entry, &target, &mut seen).await {
                Outcome::Untouched => {}
                Outcome::Moved { entry, from_file } => {
                    file.entries_mut()[index] = entry;
                    report.moved += 1;
                    cleanup.extend(from_file);
                }
                Outcome::Failed(failure) => report.failed.push(failure),
            }
        }
        if report.moved > 0 {
            file.save(&path)?;
            for (store, key) in cleanup {
                let _ = secret_store::remove(&store, &key).await;
            }
        } else if path.exists() {
            // Entries left in place stay readable only by their owner.
            let _ = secure_fs::restrict_file(&path);
        }
        Ok(report)
    }
}

/// Moves one entry's key when it has one to move (the first entry of each
/// provider and id only: [`super::credentials::read`] ignores the others).
async fn migrate_entry(
    root: &Path,
    entry: &Value,
    target: &TargetStore,
    seen: &mut HashSet<(String, String)>,
) -> Outcome {
    let (Some(id), Some(provider)) = (text(entry.get("id")), text(entry.get("provider_id"))) else {
        return Outcome::Untouched;
    };
    if !seen.insert((provider.to_owned(), id.to_owned())) {
        return Outcome::Untouched;
    }
    let failed = |code: &'static str| {
        Outcome::Failed(CredentialMigrationFailure {
            credential_id: id.to_owned(),
            code,
        })
    };
    let Ok(key) = secret_store::key(provider, id) else {
        return failed("credential_key_invalid");
    };
    let source = if let Some(secret) = text(entry.get("secret")) {
        Source::Plaintext(SecretText::new(secret.to_owned()))
    } else if text(entry.get("storage")) == Some(SecretBackend::FallbackFile.as_str())
        && target.store.backend().is_system()
    {
        Source::File(secret_store::fallback_file(root))
    } else {
        return Outcome::Untouched;
    };
    let secret = match &source {
        Source::Plaintext(secret) => SecretText::new(secret.expose().to_owned()),
        Source::File(store) => match secret_store::get(store, &key).await {
            Ok(Some(secret)) => secret,
            Ok(None) => return failed("credential_secret_missing"),
            Err(error) => return failed(error.code()),
        },
    };
    if let Err(error) = secret_store::put(&target.store, &key, secret.expose()).await {
        return failed(error.code());
    }
    let mut moved = entry.clone();
    let fields = butler_core::json::object_mut(&mut moved);
    fields.remove("secret");
    fields.insert("storage".into(), target.store.backend().as_str().into());
    if text(fields.get("masked_value")).is_none() {
        fields.insert("masked_value".into(), mask(secret.expose()).into());
    }
    Outcome::Moved {
        entry: moved,
        from_file: match source {
            Source::File(store) => Some((store, key)),
            Source::Plaintext(_) => None,
        },
    }
}

fn credential_storage_name(storage: CredentialStorage) -> &'static str {
    match storage {
        CredentialStorage::Keychain => "keychain",
        CredentialStorage::SecretService => "secret_service",
        CredentialStorage::CredentialManager => "credential_manager",
        CredentialStorage::FallbackFile => "fallback_file",
        CredentialStorage::LegacyPlaintext => "legacy_plaintext",
    }
}
