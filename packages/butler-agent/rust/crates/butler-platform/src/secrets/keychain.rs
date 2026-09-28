//! macOS: generic passwords in the user's login Keychain. An item's access
//! list trusts the program that created it; a program with another code
//! signature is asked for by the system before it can read the item.

use std::sync::Arc;

use super::{SecretBackend, SecretError};

pub(super) const BACKEND: SecretBackend = SecretBackend::Keychain;

pub(super) fn open() -> Result<Arc<keyring_core::CredentialStore>, SecretError> {
    let store: Arc<keyring_core::CredentialStore> =
        apple_native_keyring_store::keychain::Store::new().map_err(SecretError::Unavailable)?;
    Ok(store)
}
