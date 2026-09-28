//! Where provider API keys live (#217): the operating system's credential
//! store, else (no store, or `BUTLER_SECRET_STORE=file`) the owner-only file
//! `auth/credential-store.json` in the data folder. Each key is stored under
//! the service `Butler` and the account `<provider>/<credential id>`.
//!
//! Store calls block (and a desktop store may ask the user), so they run on
//! a blocking thread with a time limit. The system store is opened once per
//! process, on first use.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use butler_platform::secrets::{
    SERVICE, SecretBackend, SecretError, SecretKey, SecretStore, SecretStoreMode, SecretText,
};
use tokio::sync::OnceCell;

use crate::models::CredentialStorage;

/// The fallback file, relative to the data root.
pub(super) const FALLBACK_FILE: &str = "auth/credential-store.json";

/// How long one store call may take (a desktop store may be waiting for the
/// user to allow access).
const STORE_TIMEOUT: Duration = Duration::from_secs(60);

/// Why a key could not be read from or written to its store.
#[derive(Debug, thiserror::Error)]
pub enum CredentialStoreError {
    /// The system credential store could not be opened in this process.
    #[error("the credential store is unavailable")]
    Unavailable(#[source] Arc<CredentialStoreError>),
    /// The key is in a system store this system does not have (a data folder
    /// copied from another operating system).
    #[error("the API key is kept in a credential store this system does not have")]
    ForeignStore,
    /// The store failed the call.
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
            Self::Unavailable(_) => "credential_store_unavailable",
            Self::ForeignStore => "credential_store_foreign",
            Self::Store(error) => match error {
                SecretError::AccessDenied(_) => "credential_store_access_denied",
                SecretError::Unavailable(_) => "credential_store_unavailable",
                _ => "credential_store_failed",
            },
            Self::TimedOut => "credential_store_timeout",
            Self::Interrupted(_) => "credential_store_interrupted",
            Self::ReadBackMismatch => "credential_store_mismatch",
        }
    }
}

/// The store new keys go to, and why it is not the system store.
pub(super) struct TargetStore {
    pub(super) store: SecretStore,
    pub(super) fallback: Option<Arc<CredentialStoreError>>,
}

/// The process's view of the credential stores.
pub(super) struct ProviderSecrets {
    mode: SecretStoreMode,
    system: OnceCell<Result<SecretStore, Arc<CredentialStoreError>>>,
}

impl ProviderSecrets {
    pub(super) fn new(mode: SecretStoreMode) -> Self {
        Self {
            mode,
            system: OnceCell::new(),
        }
    }

    pub(super) fn mode(&self) -> SecretStoreMode {
        self.mode
    }

    /// The system store, opened on first use; the failure is kept for the
    /// life of the process.
    async fn system(&self) -> Result<SecretStore, Arc<CredentialStoreError>> {
        self.system
            .get_or_init(|| async { blocking(SecretStore::system).await.map_err(Arc::new) })
            .await
            .clone()
    }

    /// Where a new key goes: the system store, unless the file was asked
    /// for or the system store is unavailable.
    pub(super) async fn target(&self, root: &Path) -> TargetStore {
        if self.mode == SecretStoreMode::File {
            return TargetStore {
                store: fallback_file(root),
                fallback: None,
            };
        }
        match self.system().await {
            Ok(store) => TargetStore {
                store,
                fallback: None,
            },
            Err(error) => TargetStore {
                store: fallback_file(root),
                fallback: Some(error),
            },
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
        let store = self
            .system()
            .await
            .map_err(CredentialStoreError::Unavailable)?;
        if store.backend() == backend {
            Ok(store)
        } else {
            Err(CredentialStoreError::ForeignStore)
        }
    }
}

/// The owner-only fallback file of `root`.
pub(super) fn fallback_file(root: &Path) -> SecretStore {
    SecretStore::file(root.join(FALLBACK_FILE))
}

/// The key a provider credential is stored under.
pub(super) fn key(provider_id: &str, credential_id: &str) -> Result<SecretKey, SecretError> {
    SecretKey::new(SERVICE, &format!("{provider_id}/{credential_id}"))
}

/// Reads the key stored under `key`.
pub(super) async fn get(
    store: &SecretStore,
    key: &SecretKey,
) -> Result<Option<SecretText>, CredentialStoreError> {
    let (store, key) = (store.clone(), key.clone());
    blocking(move || store.get(&key)).await
}

/// Stores `secret` under `key` and reads it back.
pub(super) async fn put(
    store: &SecretStore,
    key: &SecretKey,
    secret: &str,
) -> Result<(), CredentialStoreError> {
    let (store, key) = (store.clone(), key.clone());
    let secret = SecretText::new(secret.to_owned());
    let verified = blocking(move || {
        store.set(&key, secret.expose())?;
        Ok(store
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
    store: &SecretStore,
    key: &SecretKey,
) -> Result<bool, CredentialStoreError> {
    let (store, key) = (store.clone(), key.clone());
    blocking(move || store.delete(&key)).await
}

/// Runs a blocking store call off the async runtime, within the time limit.
async fn blocking<T: Send + 'static>(
    call: impl FnOnce() -> Result<T, SecretError> + Send + 'static,
) -> Result<T, CredentialStoreError> {
    match tokio::time::timeout(STORE_TIMEOUT, tokio::task::spawn_blocking(call)).await {
        Ok(Ok(result)) => result.map_err(CredentialStoreError::Store),
        Ok(Err(error)) => Err(CredentialStoreError::Interrupted(error)),
        Err(_) => Err(CredentialStoreError::TimedOut),
    }
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
