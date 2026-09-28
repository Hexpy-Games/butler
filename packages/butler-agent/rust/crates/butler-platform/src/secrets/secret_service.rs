//! Linux (and other Unix systems but macOS): the freedesktop Secret Service
//! (GNOME Keyring, KWallet) over the D-Bus session bus, spoken in pure Rust.
//! Without a session bus or a Secret Service the store does not open, and
//! callers fall back to the owner-only file.

use std::sync::Arc;

use super::{SecretBackend, SecretError};

pub(super) const BACKEND: SecretBackend = SecretBackend::SecretService;

pub(super) fn open() -> Result<Arc<keyring_core::CredentialStore>, SecretError> {
    let store: Arc<keyring_core::CredentialStore> =
        zbus_secret_service_keyring_store::Store::new().map_err(SecretError::Unavailable)?;
    Ok(store)
}
