//! The start-up move of saved API keys (#217).
//!
//! Every credentials entry that still holds its key as plain text (saved
//! before #217) is moved to the store where the policy puts new keys; when
//! the policy picks the system store (a Developer ID signed build, or
//! `secrets.store = "system"`), keys in the owner-only file move there too.
//! Each key is written and read back before its entry is rewritten without
//! it (one atomic, owner-only rewrite for the whole file); a moved file key
//! is journaled for removal from the file and removed after that rewrite.
//! Later entries of an id that [`super::credentials::read`] never uses are
//! dropped, so no shadowed key stays behind in plain text. An entry whose
//! move fails keeps its key in place and is retried at the next start,
//! as are journaled removals: nothing is lost, and running the move again
//! changes nothing.

use std::collections::HashMap;
use std::path::Path;

use butler_platform::secrets::{SecretBackend, SecretStoreMode, SecretText};
use butler_platform::secure_fs;
use serde::Serialize;
use serde_json::Value;

use super::credential_admin::CredentialError;
use super::credentials::{self, CREDENTIALS_FILE, CredentialsFile, PendingRemoval, mask};
use super::secret_store::{self, CredentialStoreError, TargetStore};
use super::store_policy::{FileOverride, StoreReason};
use super::{ModelConfiguration, read_object_sync, text};
use crate::models::{CredentialStorage, ModelCatalogError};

/// What one start-up move did.
#[derive(Clone, Debug, Serialize)]
pub struct CredentialMigrationReport {
    /// Why new keys go where they go.
    pub reason: StoreReason,
    /// The store keys were moved to; `None` when nothing had to move (no
    /// store was opened).
    pub backend: Option<CredentialStorage>,
    /// Why the owner-only file is used although the system store was
    /// chosen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<&'static str>,
    /// Entries moved.
    pub moved: usize,
    /// Entries left in place, to be retried at the next start.
    pub failed: Vec<CredentialMigrationFailure>,
    /// Shadowed duplicate entries dropped.
    pub dropped_duplicates: usize,
    /// Journaled store removals still pending.
    pub pending_removals: usize,
    /// `BUTLER_SECRET_STORE=file` was ignored for the user's own data folder.
    pub override_ignored: bool,
}

/// An entry the move left in place.
#[derive(Clone, Debug, Serialize)]
pub struct CredentialMigrationFailure {
    pub credential_id: String,
    pub code: &'static str,
}

impl CredentialMigrationReport {
    /// One structured log line (never a key), or `None` when there was
    /// nothing to do or report.
    pub fn log_line(&self) -> Option<String> {
        let quiet = self.backend.is_none()
            && self.dropped_duplicates == 0
            && self.pending_removals == 0
            && !self.override_ignored;
        if quiet {
            return None;
        }
        let failures = self
            .failed
            .iter()
            .map(|failure| format!("{}:{}", failure.credential_id, failure.code))
            .collect::<Vec<_>>()
            .join(",");
        Some(format!(
            "[native-credentials] migration backend={} reason={} moved={} failed={} dropped_duplicates={} pending_removals={} fallback_reason={} override_ignored={} failures={}",
            self.backend.map_or("none", credential_storage_name),
            reason_name(self.reason),
            self.moved,
            self.failed.len(),
            self.dropped_duplicates,
            self.pending_removals,
            self.fallback_reason.unwrap_or("none"),
            self.override_ignored,
            if failures.is_empty() {
                "none"
            } else {
                &failures
            },
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
    /// Journaled store removals still pending.
    pub pending_removals: usize,
}

/// Summarizes `data_root`'s credentials file (read-only).
pub fn credential_file_summary(data_root: &Path) -> CredentialFileSummary {
    let path = data_root.join(CREDENTIALS_FILE);
    let Ok(metadata) = std::fs::symlink_metadata(&path) else {
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
    summary.pending_removals = super::array(document.get("pending_secret_removals")).len();
    summary
}

/// What happened to one entry.
enum Outcome {
    Untouched,
    Moved {
        entry: Value,
        from_file: Option<PendingRemoval>,
    },
    Failed(CredentialMigrationFailure),
}

/// Which entries move and which are shadowed duplicates.
struct Plan {
    movable: Vec<usize>,
    duplicates: Vec<usize>,
}

impl ModelConfiguration {
    /// Moves every movable key of the data root (see the module
    /// documentation). Runs once at service start, under the configuration
    /// write lock and the credentials file's change lock.
    pub async fn migrate_provider_credentials(
        &self,
    ) -> Result<CredentialMigrationReport, ModelCatalogError> {
        let _write = self.configuration_writes.acquire().await;
        let root = self.data_root.as_path();
        let (_lock, mut file) = self.open_credentials(root).await.map_err(catalog_error)?;
        let choice = self.secrets.choice(root);
        let mut report = CredentialMigrationReport {
            reason: choice.reason,
            backend: None,
            fallback_reason: None,
            moved: 0,
            failed: Vec::new(),
            dropped_duplicates: 0,
            pending_removals: 0,
            override_ignored: self.secrets.facts().file_override
                == FileOverride::IgnoredForDefaultDataRoot,
        };
        let plan = self.plan(&file, choice.mode == SecretStoreMode::System);
        if !plan.movable.is_empty() {
            self.move_entries(root, &mut file, &plan.movable, &mut report)
                .await;
        }
        for index in plan.duplicates.iter().rev() {
            file.entries_mut().remove(*index);
        }
        report.dropped_duplicates = plan.duplicates.len();
        let path = root.join(CREDENTIALS_FILE);
        if report.moved > 0 || report.dropped_duplicates > 0 {
            file.save(&path)?;
        } else if path.exists() {
            // Entries left in place stay readable only by their owner.
            let _ = secure_fs::restrict_file(&path);
        }
        report.pending_removals = self.flush_removals(root, &mut file).await;
        Ok(report)
    }

    /// The canonical entry of each id is the one `credentials::read` uses
    /// (the first usable one, else the first); it moves when it holds a
    /// plain-text key, or a file key while `upgrade` (the system store is
    /// chosen). Every other entry of an id is a duplicate.
    fn plan(&self, file: &CredentialsFile, upgrade: bool) -> Plan {
        let entries = file.entries();
        let mut canonical: HashMap<&str, usize> = HashMap::new();
        for (index, entry) in entries.iter().enumerate() {
            let usable =
                credentials::record(entry, &self.registration_catalog, self.clock.as_ref())
                    .is_some();
            if let Some(id) = text(entry.get("id")).filter(|_| usable) {
                canonical.entry(id).or_insert(index);
            }
        }
        for (index, entry) in entries.iter().enumerate() {
            if let Some(id) = text(entry.get("id")) {
                canonical.entry(id).or_insert(index);
            }
        }
        let mut plan = Plan {
            movable: Vec::new(),
            duplicates: Vec::new(),
        };
        for (index, entry) in entries.iter().enumerate() {
            let Some(id) = text(entry.get("id")) else {
                continue;
            };
            if canonical.get(id) != Some(&index) {
                plan.duplicates.push(index);
            } else if text(entry.get("secret")).is_some()
                || (upgrade
                    && text(entry.get("storage")) == Some(SecretBackend::FallbackFile.as_str()))
            {
                plan.movable.push(index);
            }
        }
        plan
    }

    /// Moves the `movable` entries to the store new keys go to.
    async fn move_entries(
        &self,
        root: &Path,
        file: &mut CredentialsFile,
        movable: &[usize],
        report: &mut CredentialMigrationReport,
    ) {
        let target = match self.secrets.target(root).await {
            Ok(target) => target,
            Err(error) => {
                report.failed = movable
                    .iter()
                    .filter_map(|index| file.entries().get(*index))
                    .filter_map(|entry| text(entry.get("id")))
                    .map(|id| CredentialMigrationFailure {
                        credential_id: id.to_owned(),
                        code: error.code(),
                    })
                    .collect();
                return;
            }
        };
        report.backend = Some(target.store.backend().into());
        report.fallback_reason = target.fallback.as_deref().map(CredentialStoreError::code);
        for index in movable {
            let Some(entry) = file.entries().get(*index).cloned() else {
                continue;
            };
            match self.migrate_entry(root, &entry, &target).await {
                Outcome::Untouched => {}
                Outcome::Moved { entry, from_file } => {
                    file.entries_mut()[*index] = entry;
                    report.moved += 1;
                    if let Some(removal) = from_file {
                        file.schedule_removal(&removal);
                    }
                }
                Outcome::Failed(failure) => report.failed.push(failure),
            }
        }
    }

    /// Moves one entry's key to `target` when it has one to move there.
    async fn migrate_entry(&self, root: &Path, entry: &Value, target: &TargetStore) -> Outcome {
        let (Some(id), Some(provider)) = (text(entry.get("id")), text(entry.get("provider_id")))
        else {
            return Outcome::Untouched;
        };
        let failed = |code: &'static str| {
            Outcome::Failed(CredentialMigrationFailure {
                credential_id: id.to_owned(),
                code,
            })
        };
        let backend = target.store.backend();
        let from_file = text(entry.get("secret")).is_none();
        if from_file && !backend.is_system() {
            return Outcome::Untouched;
        }
        let secret = if let Some(secret) = text(entry.get("secret")) {
            SecretText::new(secret.to_owned())
        } else {
            let Ok(key) = secret_store::key(root, SecretBackend::FallbackFile, provider, id) else {
                return failed("credential_key_invalid");
            };
            match self
                .secrets
                .get(&secret_store::fallback_file(root), &key)
                .await
            {
                Ok(Some(secret)) => secret,
                Ok(None) => return failed("credential_secret_missing"),
                Err(error) => return failed(error.code()),
            }
        };
        let Ok(key) = secret_store::key(root, backend, provider, id) else {
            return failed("credential_key_invalid");
        };
        if let Err(error) = self.secrets.put(&target.store, &key, secret.expose()).await {
            return failed(error.code());
        }
        let mut moved = entry.clone();
        let fields = butler_core::json::object_mut(&mut moved);
        fields.remove("secret");
        fields.insert("storage".into(), backend.as_str().into());
        if text(fields.get("masked_value")).is_none() {
            fields.insert("masked_value".into(), mask(secret.expose()).into());
        }
        if text(fields.get("fingerprint")).is_none()
            && let Some(fingerprint) = secret_store::fingerprint(root, provider, secret.expose())
        {
            fields.insert("fingerprint".into(), fingerprint.into());
        }
        Outcome::Moved {
            entry: moved,
            from_file: from_file.then(|| PendingRemoval {
                backend: SecretBackend::FallbackFile,
                provider_id: provider.to_owned(),
                id: id.to_owned(),
            }),
        }
    }
}

fn catalog_error(error: CredentialError) -> ModelCatalogError {
    super::mutations::catalog_error(error)
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

fn reason_name(reason: StoreReason) -> &'static str {
    match reason {
        StoreReason::UnsignedBuild => "unsigned_build",
        StoreReason::SignedBuild => "signed_build",
        StoreReason::Config => "config",
        StoreReason::TestOverride => "test_override",
    }
}
