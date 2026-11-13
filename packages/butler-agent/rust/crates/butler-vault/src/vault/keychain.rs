//! The keychain unlock path: one item holding the device identity.

use super::VaultError;
use super::device_key::DeviceKey;
use butler_platform::secrets::{SecretKey, SecretStore, seal_secret, unseal_secret};
use butler_platform::secure_fs;
use butler_platform::user_dirs;
use sha2::{Digest, Sha256};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// The item's service; another data folder gets its own suffixed service, so
/// test and secondary folders never read or delete the owner's key.
pub const KEYCHAIN_SERVICE: &str = "com.hexpy.butler.vault";
const ACCOUNT: &str = "device-identity";

/// Where a data folder's device identity is kept in the OS credential store.
pub struct KeychainSlot {
    backing: Backing,
    key: SecretKey,
}

enum Backing {
    Store(SecretStore),
    Sealed(PathBuf),
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
        let key = keychain_key(data_root)?;
        Ok(Self {
            backing: Backing::Store(store),
            key,
        })
    }

    /// Keeps this data folder's identity sealed for this user and machine.
    pub fn sealed(data_root: &Path) -> Result<Self, VaultError> {
        Ok(Self {
            backing: Backing::Sealed(data_root.join("auth/vault-key.cred")),
            key: keychain_key(data_root)?,
        })
    }

    /// What the item is stored under.
    pub fn key(&self) -> &SecretKey {
        &self.key
    }

    pub(super) fn read(&self) -> Result<Option<DeviceKey>, VaultError> {
        let text = match &self.backing {
            Backing::Store(store) => store.get(&self.key).map_err(VaultError::Store)?,
            Backing::Sealed(path) => match std::fs::read(path) {
                Ok(bytes) => {
                    Some(unseal_secret(self.key.service(), &bytes).map_err(VaultError::Io)?)
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => return Err(VaultError::Io(error)),
            },
        };
        text.map(|text| DeviceKey::parse(text.expose())).transpose()
    }

    /// Stores the identity and reads it back, so nothing is ever encrypted to
    /// a key that was not kept.
    pub(super) fn write(&self, key: &DeviceKey) -> Result<(), VaultError> {
        match &self.backing {
            Backing::Store(store) => store
                .set(&self.key, key.text().expose())
                .map_err(VaultError::Store)?,
            Backing::Sealed(path) => {
                let sealed =
                    seal_secret(self.key.service(), &key.text()).map_err(VaultError::Io)?;
                secure_fs::replace_private(
                    path,
                    |file| file.write_all(&sealed),
                    std::convert::identity,
                )
                .map_err(VaultError::Io)?;
            }
        }
        match self.read()? {
            Some(stored) if stored.same_as(key) => Ok(()),
            _ => Err(VaultError::NoKey),
        }
    }

    pub(super) fn delete(&self) -> Result<(), VaultError> {
        match &self.backing {
            Backing::Store(store) => store
                .delete(&self.key)
                .map(|_| ())
                .map_err(VaultError::Store),
            Backing::Sealed(path) => match std::fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(VaultError::Io(error)),
            },
        }
    }
}

/// What a data folder's vault key is stored under (for cleanup by full reset).
pub fn keychain_key(data_root: &Path) -> Result<SecretKey, VaultError> {
    SecretKey::new(&service(data_root)?, ACCOUNT).map_err(VaultError::Store)
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
