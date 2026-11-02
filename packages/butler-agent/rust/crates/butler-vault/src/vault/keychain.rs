//! The keychain unlock path: one item holding the device identity.

use super::VaultError;
use super::device_key::DeviceKey;
use butler_platform::secrets::{SecretKey, SecretStore};
use butler_platform::user_dirs;
use sha2::{Digest, Sha256};
use std::path::Path;

/// The item's service; another data folder gets its own suffixed service, so
/// test and secondary folders never read or delete the owner's key.
pub const KEYCHAIN_SERVICE: &str = "com.hexpy.butler.vault";
const ACCOUNT: &str = "device-identity";

/// Where a data folder's device identity is kept in the OS credential store.
pub struct KeychainSlot {
    store: SecretStore,
    key: SecretKey,
}

impl KeychainSlot {
    /// Refuses a store that is not the operating system's: the key must never
    /// sit unwrapped in a file beside the ciphertext. The data folder must
    /// exist: the item's name comes from its real path, so that it stays the
    /// same however the folder is reached.
    pub fn new(store: SecretStore, data_root: &Path) -> Result<Self, VaultError> {
        if !store.backend().is_system() {
            return Err(VaultError::NotSystemStore);
        }
        let key = SecretKey::new(&service(data_root)?, ACCOUNT).map_err(VaultError::Store)?;
        Ok(Self { store, key })
    }

    /// What the item is stored under.
    pub fn key(&self) -> &SecretKey {
        &self.key
    }

    pub(super) fn read(&self) -> Result<Option<DeviceKey>, VaultError> {
        let text = self.store.get(&self.key).map_err(VaultError::Store)?;
        text.map(|text| DeviceKey::parse(text.expose())).transpose()
    }

    /// Stores the identity and reads it back, so nothing is ever encrypted to
    /// a key that was not kept.
    pub(super) fn write(&self, key: &DeviceKey) -> Result<(), VaultError> {
        self.store
            .set(&self.key, key.text().expose())
            .map_err(VaultError::Store)?;
        match self.read()? {
            Some(stored) if stored.same_as(key) => Ok(()),
            _ => Err(VaultError::NoKey),
        }
    }

    pub(super) fn delete(&self) -> Result<(), VaultError> {
        self.store
            .delete(&self.key)
            .map(|_| ())
            .map_err(VaultError::Store)
    }
}

#[allow(
    clippy::disallowed_methods,
    reason = "saved keychain services hash this spelling; another form would orphan them"
)]
fn service(root: &Path) -> Result<String, VaultError> {
    let root = std::fs::canonicalize(root).map_err(VaultError::Io)?;
    let default =
        user_dirs::home_dir().and_then(|home| std::fs::canonicalize(home.join(".butler")).ok());
    if default.as_ref() == Some(&root) {
        return Ok(KEYCHAIN_SERVICE.to_owned());
    }
    let digest = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
    Ok(format!(
        "{KEYCHAIN_SERVICE}.{}",
        digest.get(..12).unwrap_or(&digest)
    ))
}
