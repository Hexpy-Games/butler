//! The primitives every key change is built from (#217): writing a key to
//! the store the policy picks and its masked record to the credentials file,
//! reading a key when a request needs it, and carrying out the journaled
//! removals of store entries nothing uses any more.

use std::path::Path;

use butler_platform::secrets::{SecretBackend, SecretText};

use super::ModelConfiguration;
use super::credential_admin::{CredentialDraft, CredentialError};
use super::credentials::{
    self, CREDENTIALS_FILE, CredentialRecord, CredentialsFile, PendingRemoval, SecretHome,
};
use super::secret_store;
use crate::models::{CredentialView, ModelCatalogError};

impl ModelConfiguration {
    /// Stores `secret` for `draft` where the policy puts new keys, then
    /// writes the record (masked, fingerprinted) to `file`. A key moved from
    /// another store is journaled for removal there. The caller holds the
    /// configuration write lock and the file's change lock.
    pub(super) async fn write_credential(
        &self,
        root: &Path,
        file: &mut CredentialsFile,
        draft: CredentialDraft,
        secret: &str,
        previous: Option<&SecretHome>,
    ) -> Result<CredentialView, CredentialError> {
        let target = self.secrets.target(root).await?;
        let backend = target.store.backend();
        let key = secret_store::key(root, backend, &draft.provider_id, &draft.id)
            .map_err(|error| CredentialError::Store(error.into()))?;
        self.secrets.put(&target.store, &key, secret).await?;
        let record = CredentialRecord {
            fingerprint: secret_store::fingerprint(root, &draft.provider_id, secret),
            masked_value: credentials::mask(secret),
            home: SecretHome::Store(backend),
            updated_at: self.clock.now_iso(),
            id: draft.id,
            provider_id: draft.provider_id,
            label: draft.label,
            created_at: draft.created_at,
        };
        if let Some(SecretHome::Store(old)) = previous
            && *old != backend
        {
            file.schedule_removal(&PendingRemoval {
                backend: *old,
                provider_id: record.provider_id.clone(),
                id: record.id.clone(),
            });
        }
        file.put(&record);
        let path = root.join(CREDENTIALS_FILE);
        if let Err(error) = file.save(&path) {
            if previous.is_none() {
                let _ = self.secrets.remove(&target.store, &key).await;
            }
            return Err(error.into());
        }
        self.flush_removals(root, file).await;
        Ok(record.view())
    }

    /// The key of `record`, read from its store now; it is not kept.
    pub(super) async fn credential_secret(
        &self,
        root: &Path,
        record: &CredentialRecord,
    ) -> Result<SecretText, CredentialError> {
        let backend = match &record.home {
            SecretHome::Plaintext(secret) => return Ok(SecretText::new(secret.expose().into())),
            SecretHome::Store(backend) => *backend,
        };
        let store = self.secrets.holding(root, backend).await?;
        let key = secret_store::key(root, backend, &record.provider_id, &record.id)
            .map_err(|error| CredentialError::Store(error.into()))?;
        self.secrets
            .get(&store, &key)
            .await?
            .ok_or(CredentialError::SecretMissing)
    }

    /// Carries out the journaled removals of `file` (under `root`) and saves
    /// what is done; a removal that fails stays journaled for the next
    /// change or start. An entry a record uses again is never removed.
    /// Returns how many removals are still pending.
    pub(super) async fn flush_removals(&self, root: &Path, file: &mut CredentialsFile) -> usize {
        let pending = file.pending_removals();
        if pending.is_empty() {
            return 0;
        }
        let records = file.records(&self.registration_catalog, self.clock.as_ref());
        let mut done = Vec::new();
        for removal in &pending {
            let in_use = records.iter().any(|record| {
                record.id == removal.id
                    && record.provider_id == removal.provider_id
                    && stored_in(record, removal.backend)
            });
            if in_use || self.remove_secret(root, removal).await {
                done.push(removal.clone());
            }
        }
        if !done.is_empty() {
            file.finish_removals(&done);
            if file.save(&root.join(CREDENTIALS_FILE)).is_err() {
                return pending.len();
            }
        }
        pending.len() - done.len()
    }

    /// Removes one store entry; true when it is gone (or never was).
    async fn remove_secret(&self, root: &Path, removal: &PendingRemoval) -> bool {
        let Ok(key) = secret_store::key(root, removal.backend, &removal.provider_id, &removal.id)
        else {
            return true;
        };
        match self.secrets.holding(root, removal.backend).await {
            Ok(store) => self.secrets.remove(&store, &key).await.is_ok(),
            Err(_) => false,
        }
    }

    /// Takes the credentials file's change lock under `root` and loads it.
    pub(super) async fn open_credentials(
        &self,
        root: &Path,
    ) -> Result<(butler_platform::secrets::ChangeLock, CredentialsFile), CredentialError> {
        let path = root.join(CREDENTIALS_FILE);
        let lock = CredentialsFile::lock(&path).await?;
        let file = if butler_platform::secure_fs::OWNER_ONLY {
            CredentialsFile::load(&path)?
        } else {
            tokio::task::spawn_blocking(move || CredentialsFile::load(&path))
                .await
                .map_err(|_| {
                    ModelCatalogError::rejected("The saved API keys could not be read.")
                })??
        };
        Ok((lock, file))
    }
}

/// Whether `record` keeps its key in `backend`.
fn stored_in(record: &CredentialRecord, backend: SecretBackend) -> bool {
    matches!(record.home, SecretHome::Store(stored) if stored == backend)
}
