//! The credential stores provider API keys live in (#217): the owner-only
//! file `auth/credential-store.json`, or the system store when the policy
//! (`store_policy`) picks it.
//!
//! Keys: the account is `<provider>/<credential id>`; the service is
//! `com.hexpy.butler.model-credential` in the file, and in the system store
//! that name plus a hash of the data root, so two data folders never share
//! (or delete) each other's keys.
//!
//! Store calls block (and a desktop store may ask the user), so they run on
//! a blocking thread with a time limit, one system-store call at a time: a
//! call waiting for an answer nobody gives (a scheduled run) fails with
//! `credential_store_timeout` instead of piling up threads. The system store
//! is opened on first use and kept once it answers; a failure is retried at
//! the next use. It falls back to the file only when it does not exist on
//! this host (`Unavailable`), never when it refuses access.

use std::fmt::Write as _;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use butler_platform::secrets::{
    SecretBackend, SecretError, SecretKey, SecretStore, SecretStoreMode, SecretText,
};
use butler_platform::secure_fs;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, Semaphore};

use super::read_object_sync;
use super::store_policy::{SecretStoreFacts, StoreChoice, choose};
use crate::models::CredentialStorage;

/// The fallback file, relative to the data root.
pub(super) const FALLBACK_FILE: &str = "auth/credential-store.json";

/// The data-folder secret key fingerprints are made with.
const FINGERPRINT_KEY_FILE: &str = "auth/credential-fingerprint.key";

/// The service keys are stored under (plus a data-root hash in the system
/// store).
const SERVICE: &str = "com.hexpy.butler.model-credential";

/// How long one store call may take, and how long a call waits for the one
/// before it.
const STORE_TIMEOUT: Duration = Duration::from_secs(30);

/// Why a key could not be read from or written to its store.
#[derive(Debug, thiserror::Error)]
pub enum CredentialStoreError {
    /// The key is in a system store this host does not have (a data folder
    /// copied from another operating system).
    #[error("the API key is kept in a credential store this system does not have")]
    ForeignStore,
    /// The store failed the call or refused access.
    #[error(transparent)]
    Store(#[from] SecretError),
    /// The store did not answer within the time limit.
    #[error("the credential store did not answer in time")]
    TimedOut,
    /// The blocking call ended without an answer.
    #[error("the credential store call was interrupted")]
    Interrupted(#[source] tokio::task::JoinError),
    /// The written key read back differently.
    #[error("the credential store returned a different key than was written")]
    ReadBackMismatch,
}

impl CredentialStoreError {
    /// A stable code for reports and logs.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Store(SecretError::Unavailable(_)) => "credential_store_unavailable",
            Self::ForeignStore => "credential_store_foreign",
            Self::Store(SecretError::AccessDenied(_)) => "credential_store_access_denied",
            Self::Store(_) => "credential_store_failed",
            Self::TimedOut => "credential_store_timeout",
            Self::Interrupted(_) => "credential_store_interrupted",
            Self::ReadBackMismatch => "credential_store_mismatch",
        }
    }

    /// Whether the system store does not exist here (the only case that
    /// falls back to the file).
    fn is_unavailable(&self) -> bool {
        matches!(self, Self::Store(SecretError::Unavailable(_)))
    }
}

/// The store new keys go to, and why it is the file although the system
/// store was chosen.
pub(super) struct TargetStore {
    pub(super) store: SecretStore,
    pub(super) fallback: Option<Arc<CredentialStoreError>>,
}

/// The process's view of the credential stores.
pub(super) struct ProviderSecrets {
    facts: SecretStoreFacts,
    system: Mutex<Option<SecretStore>>,
    system_calls: Arc<Semaphore>,
}

impl ProviderSecrets {
    pub(super) fn new(facts: SecretStoreFacts) -> Self {
        Self {
            facts,
            system: Mutex::new(None),
            system_calls: Arc::new(Semaphore::new(1)),
        }
    }

    pub(super) fn facts(&self) -> SecretStoreFacts {
        self.facts
    }

    /// The policy's choice for `root` (reads its configuration).
    pub(super) fn choice(&self, root: &Path) -> StoreChoice {
        choose(
            self.facts,
            &read_object_sync(&root.join("butler.config.json")),
        )
    }

    /// The system store, opened on first use and kept once it answers.
    async fn system(&self) -> Result<SecretStore, CredentialStoreError> {
        let mut cached = self.system.lock().await;
        if let Some(store) = cached.as_ref() {
            return Ok(store.clone());
        }
        let store = self.call(true, SecretStore::system).await?;
        *cached = Some(store.clone());
        Ok(store)
    }

    /// Where a new key goes (see the module documentation for the fallback).
    pub(super) async fn target(&self, root: &Path) -> Result<TargetStore, CredentialStoreError> {
        let choice = self.choice(root);
        if choice.mode == SecretStoreMode::File {
            return Ok(TargetStore {
                store: fallback_file(root),
                fallback: None,
            });
        }
        match self.system().await {
            Ok(store) => Ok(TargetStore {
                store,
                fallback: None,
            }),
            Err(error) if error.is_unavailable() => Ok(TargetStore {
                store: fallback_file(root),
                fallback: Some(Arc::new(error)),
            }),
            Err(error) => Err(error),
        }
    }

    /// The store that holds keys saved to `backend`.
    pub(super) async fn holding(
        &self,
        root: &Path,
        backend: SecretBackend,
    ) -> Result<SecretStore, CredentialStoreError> {
        if backend == SecretBackend::FallbackFile {
            return Ok(fallback_file(root));
        }
        let store = self.system().await?;
        if store.backend() == backend {
            Ok(store)
        } else {
            Err(CredentialStoreError::ForeignStore)
        }
    }

    /// Reads the key stored under `key`.
    pub(super) async fn get(
        &self,
        store: &SecretStore,
        key: &SecretKey,
    ) -> Result<Option<SecretText>, CredentialStoreError> {
        let (owned, key) = (store.clone(), key.clone());
        self.call(store.backend().is_system(), move || owned.get(&key))
            .await
    }

    /// Stores `secret` under `key` and reads it back.
    pub(super) async fn put(
        &self,
        store: &SecretStore,
        key: &SecretKey,
        secret: &str,
    ) -> Result<(), CredentialStoreError> {
        let (owned, key) = (store.clone(), key.clone());
        let secret = SecretText::new(secret.to_owned());
        let verified = self
            .call(store.backend().is_system(), move || {
                owned.set(&key, secret.expose())?;
                Ok(owned
                    .get(&key)?
                    .is_some_and(|read| read.expose() == secret.expose()))
            })
            .await?;
        if verified {
            Ok(())
        } else {
            Err(CredentialStoreError::ReadBackMismatch)
        }
    }

    /// Removes the key stored under `key`; false when there was none.
    pub(super) async fn remove(
        &self,
        store: &SecretStore,
        key: &SecretKey,
    ) -> Result<bool, CredentialStoreError> {
        let (owned, key) = (store.clone(), key.clone());
        self.call(store.backend().is_system(), move || owned.delete(&key))
            .await
    }

    /// Runs a blocking store call off the async runtime within the time
    /// limit; system-store calls one at a time.
    async fn call<T: Send + 'static>(
        &self,
        system: bool,
        work: impl FnOnce() -> Result<T, SecretError> + Send + 'static,
    ) -> Result<T, CredentialStoreError> {
        let permit = if system {
            let waiting = self.system_calls.clone().acquire_owned();
            match tokio::time::timeout(STORE_TIMEOUT, waiting).await {
                Ok(Ok(permit)) => Some(permit),
                _ => return Err(CredentialStoreError::TimedOut),
            }
        } else {
            None
        };
        let task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            work()
        });
        match tokio::time::timeout(STORE_TIMEOUT, task).await {
            Ok(Ok(result)) => result.map_err(CredentialStoreError::Store),
            Ok(Err(error)) => Err(CredentialStoreError::Interrupted(error)),
            Err(_) => Err(CredentialStoreError::TimedOut),
        }
    }
}

/// The owner-only fallback file of `root`.
pub(super) fn fallback_file(root: &Path) -> SecretStore {
    SecretStore::file(root.join(FALLBACK_FILE))
}

/// The key a provider credential is stored under in `backend`.
pub(super) fn key(
    root: &Path,
    backend: SecretBackend,
    provider_id: &str,
    credential_id: &str,
) -> Result<SecretKey, SecretError> {
    let account = format!("{provider_id}/{credential_id}");
    if backend.is_system() {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let digest = Sha256::digest(root.to_string_lossy().as_bytes());
        let hash = hex(digest.get(..8).unwrap_or_default());
        SecretKey::new(&format!("{SERVICE}.{hash}"), &account)
    } else {
        SecretKey::new(SERVICE, &account)
    }
}

/// An HMAC-SHA-256 of `provider_id` and `secret` under the data folder's
/// fingerprint key (created on first use, owner-only): lets a save find the
/// same key already saved without reading any store. `None` when the key
/// file cannot be read or created.
pub(super) fn fingerprint(root: &Path, provider_id: &str, secret: &str) -> Option<String> {
    let key = fingerprint_key(root)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).ok()?;
    mac.update(provider_id.as_bytes());
    mac.update(b"\n");
    mac.update(secret.as_bytes());
    Some(hex(&mac.finalize().into_bytes()))
}

fn fingerprint_key(root: &Path) -> Option<zeroize::Zeroizing<String>> {
    let path = root.join(FINGERPRINT_KEY_FILE);
    if let Ok(mut file) = secure_fs::open_read_no_follow(&path) {
        let mut key = zeroize::Zeroizing::new(String::new());
        file.read_to_string(&mut key).ok()?;
        return (key.len() == 64).then_some(key);
    }
    let fresh = zeroize::Zeroizing::new(format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    ));
    secure_fs::create_private_dir_all(path.parent()?).ok()?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    let _ = secure_fs::owner_only(&mut options);
    match options.open(&path) {
        Ok(mut file) => {
            file.write_all(fresh.as_bytes()).ok()?;
            file.sync_all().ok()?;
            Some(fresh)
        }
        // Another process created it first: use theirs.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let mut key = zeroize::Zeroizing::new(String::new());
            secure_fs::open_read_no_follow(&path)
                .ok()?
                .read_to_string(&mut key)
                .ok()?;
            (key.len() == 64).then_some(key)
        }
        Err(_) => None,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");
        text
    })
}

impl From<SecretBackend> for CredentialStorage {
    fn from(backend: SecretBackend) -> Self {
        match backend {
            SecretBackend::Keychain => Self::Keychain,
            SecretBackend::SecretService => Self::SecretService,
            SecretBackend::CredentialManager => Self::CredentialManager,
            SecretBackend::FallbackFile => Self::FallbackFile,
        }
    }
}
