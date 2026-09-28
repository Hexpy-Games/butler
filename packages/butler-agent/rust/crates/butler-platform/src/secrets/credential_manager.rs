//! Windows: generic credentials in the user's Credential Manager (available
//! to the interactive user's processes, which is why the agent runs as a
//! logon task rather than a service).

use std::sync::Arc;

use super::{SecretBackend, SecretError};

pub(super) const BACKEND: SecretBackend = SecretBackend::CredentialManager;

pub(super) fn open() -> Result<Arc<keyring_core::CredentialStore>, SecretError> {
    let store: Arc<keyring_core::CredentialStore> =
        windows_native_keyring_store::Store::new().map_err(SecretError::Unavailable)?;
    Ok(store)
}
