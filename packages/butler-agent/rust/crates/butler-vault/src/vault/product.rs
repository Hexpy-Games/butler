//! The product's vault after a verified copy from its legacy stores.
use super::{ItemKind, KeychainSlot, NewItem, Vault, VaultError, VaultPaths, VaultState};
use butler_platform::secrets::{SecretKey, SecretStore, SecretText};
use butler_platform::secure_fs;
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DECLINED_MARKER: &str = "auth/vault-declined.json";

pub const MIGRATION_MARKER: &str = "auth/vault-migration.json";

/// Where a legacy secret may be: a system-store entry, or a value already read.
pub enum LegacySource {
    System(SecretKey),
    Value(SecretText),
}

/// One secret to copy: its vault id and kind, and its legacy places in order
/// (the first that holds a value wins).
pub struct LegacyItem {
    pub id: String,
    pub kind: ItemKind,
    pub sources: Vec<LegacySource>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SwitchReport {
    pub already: bool,
    pub copied: usize,
    pub missing: usize,
}

pub struct ProductVault {
    data_root: PathBuf,
    vault: Vault,
    unlocking: Mutex<()>,
    unlock_failed: AtomicBool,
}

/// The process's one ProductVault for `data_root` (key: secure_fs::canonicalize,
/// else the path as given). No other I/O.
pub fn shared(data_root: &Path) -> Arc<ProductVault> {
    static VAULTS: OnceLock<Mutex<HashMap<PathBuf, Arc<ProductVault>>>> = OnceLock::new();
    let root = secure_fs::canonicalize(data_root).unwrap_or_else(|_| data_root.to_path_buf());
    let mut vaults = VAULTS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    vaults
        .entry(root.clone())
        .or_insert_with(|| {
            Arc::new(ProductVault {
                vault: Vault::new(VaultPaths::in_data_root(&root)),
                data_root: root,
                unlocking: Mutex::new(()),
                unlock_failed: AtomicBool::new(false),
            })
        })
        .clone()
}

impl ProductVault {
    /// Whether this data folder's secrets live in the vault (the migration
    /// marker exists). A locked vault is unlocked once with the keychain key;
    /// a failed unlock is not retried in this process, so a refused keychain
    /// never asks once per secret.
    pub fn active(&self) -> Result<bool, VaultError> {
        if !self.data_root.join(MIGRATION_MARKER).is_file() {
            return Ok(false);
        }
        if self.vault.state()? == VaultState::Unlocked {
            return Ok(true);
        }
        let _unlocking = self
            .unlocking
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        match self.vault.state()? {
            VaultState::Unlocked => return Ok(true),
            VaultState::Absent => return Err(VaultError::Absent),
            VaultState::Locked => (),
        }
        if self.unlock_failed.load(Ordering::Relaxed) {
            return Err(VaultError::Locked);
        }
        let unlocked = SecretStore::system()
            .map_err(VaultError::Store)
            .and_then(|store| KeychainSlot::new(store, &self.data_root))
            .and_then(|slot| self.vault.unlock_with_keychain(&slot));
        if unlocked.is_err() {
            self.unlock_failed.store(true, Ordering::Relaxed);
        }
        unlocked.map(|()| true)
    }

    /// Creates or unlocks the vault with the keychain key, then, once, copies
    /// every legacy secret, reads each back and writes the marker. Any error
    /// leaves the marker absent, so the legacy stores keep serving and the
    /// next start copies again.
    pub fn switch(
        &self,
        store: &SecretStore,
        items: impl FnOnce() -> io::Result<Vec<LegacyItem>>,
    ) -> Result<SwitchReport, VaultError> {
        let slot = KeychainSlot::new(store.clone(), &self.data_root)?;
        match self.vault.state()? {
            VaultState::Absent => self.vault.create_with_keychain(&slot)?,
            VaultState::Locked => self.vault.unlock_with_keychain(&slot)?,
            VaultState::Unlocked => (),
        }
        if self.data_root.join(MIGRATION_MARKER).is_file() {
            return Ok(SwitchReport {
                already: true,
                ..SwitchReport::default()
            });
        }
        let mut found = Vec::new();
        let mut kept = Vec::new();
        let mut missing = 0;
        for item in items().map_err(VaultError::Io)? {
            let mut value = None;
            for source in item.sources {
                value = match source {
                    LegacySource::System(key) => store.get(&key).map_err(VaultError::Store)?,
                    LegacySource::Value(value) => Some(value),
                };
                if value.is_some() {
                    break;
                }
            }
            if let Some(value) = value {
                kept.push((item.id.clone(), SecretText::new(value.expose().to_owned())));
                found.push(NewItem {
                    id: item.id,
                    kind: item.kind,
                    value,
                });
            } else {
                missing += 1;
            }
        }
        let copied = found.len();
        if !found.is_empty() {
            self.vault.put_many(found)?;
        }
        let payload = self.vault.read()?;
        for (id, value) in kept {
            if payload
                .item(&id)
                .is_none_or(|item| item.value.expose() != value.expose())
            {
                return Err(VaultError::CopyMismatch);
            }
        }
        let migrated_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis());
        let marker = serde_json::json!({"format": 1, "items": copied, "migrated_at": migrated_at});
        secure_fs::replace_private(
            &self.data_root.join(MIGRATION_MARKER),
            |file| file.write_all(marker.to_string().as_bytes()),
            std::convert::identity,
        )
        .map_err(VaultError::Io)?;
        Ok(SwitchReport {
            already: false,
            copied,
            missing,
        })
    }

    pub fn items_with_prefix(&self, prefix: &str) -> Result<Vec<(String, SecretText)>, VaultError> {
        Ok(self
            .vault
            .read()?
            .items
            .iter()
            .filter(|item| item.id.starts_with(prefix))
            .map(|item| (item.id.clone(), item.value.to_secret_text()))
            .collect())
    }

    pub fn item_kinds(&self) -> Result<Vec<ItemKind>, VaultError> {
        Ok(self
            .vault
            .read()?
            .items
            .iter()
            .map(|item| item.kind)
            .collect())
    }

    pub fn decline(&self) -> Result<(), VaultError> {
        secure_fs::create_private_dir_all(&self.data_root.join("auth")).map_err(VaultError::Io)?;
        let declined_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis());
        let marker = serde_json::json!({"declined_at": declined_at});
        secure_fs::replace_private(
            &self.data_root.join(DECLINED_MARKER),
            |file| file.write_all(marker.to_string().as_bytes()),
            std::convert::identity,
        )
        .map_err(VaultError::Io)
    }

    pub fn declined(&self) -> bool {
        self.data_root.join(DECLINED_MARKER).is_file()
    }

    pub fn get(&self, id: &str) -> Result<Option<SecretText>, VaultError> {
        self.vault.get(id)
    }

    pub fn put(&self, id: &str, kind: ItemKind, value: SecretText) -> Result<(), VaultError> {
        self.vault.put(NewItem {
            id: id.into(),
            kind,
            value,
        })
    }

    pub fn delete(&self, id: &str) -> Result<bool, VaultError> {
        self.vault.delete(id)
    }
}
