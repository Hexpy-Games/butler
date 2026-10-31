//! Creating a vault and managing its two unlock paths. Both open the same
//! device identity, and at least one always remains.

use super::VaultError;
use super::cipher;
use super::device_key::DeviceKey;
use super::format::Payload;
use super::keychain::KeychainSlot;
use super::store::{Vault, read_file, seal, write_private};
use butler_platform::secrets::SecretText;
use std::path::Path;
use std::sync::PoisonError;

impl Vault {
    /// Creates a vault whose key is in the keychain, reusing a key already
    /// there, so a crash before the file appears loses nothing. A password
    /// file left without a vault protects nothing and is removed.
    pub fn create_with_keychain(&self, slot: &KeychainSlot) -> Result<(), VaultError> {
        self.prepare_folder()?;
        let change = self.change_lock()?;
        self.refuse_existing()?;
        let key = match slot.read()? {
            Some(key) => key,
            None => {
                let key = DeviceKey::generate();
                slot.write(&key)?;
                key
            }
        };
        remove_if_present(&self.paths.key_file)?;
        self.write_first_save(&key)?;
        // A save holds the key's read lock while it waits for this one.
        drop(change);
        self.set_key(key);
        Ok(())
    }

    /// Creates a vault whose key only `password` opens: the unlock path for a
    /// host with no keychain. A password file left without a vault is replaced.
    pub fn create_with_password(&self, password: &SecretText) -> Result<(), VaultError> {
        cipher::check_new_password(password)?;
        self.prepare_folder()?;
        let change = self.change_lock()?;
        self.refuse_existing()?;
        let key = DeviceKey::generate();
        write_private(&self.paths.key_file, &key.wrap(password)?)?;
        self.write_first_save(&key)?;
        drop(change);
        self.set_key(key);
        Ok(())
    }

    /// Unlocks with the keychain's key. A key that opens neither the vault nor
    /// its previous copy is [`VaultError::Refused`] and stays out of memory.
    pub fn unlock_with_keychain(&self, slot: &KeychainSlot) -> Result<(), VaultError> {
        let key = slot.read()?.ok_or(VaultError::NoKey)?;
        self.require_key_opens(&key)?;
        self.set_key(key);
        Ok(())
    }

    /// Unlocks with the master password; a wrong one leaves the vault locked,
    /// and so does a key that opens neither the vault nor its previous copy.
    pub fn unlock_with_password(&self, password: &SecretText) -> Result<(), VaultError> {
        let wrapped = read_file(&self.paths.key_file, VaultError::NoKey)?;
        let key = DeviceKey::unwrap(password, &wrapped)?;
        self.require_key_opens(&key)?;
        self.set_key(key);
        Ok(())
    }

    /// Whether a master password is set.
    pub fn has_password(&self) -> Result<bool, VaultError> {
        self.paths.key_file.try_exists().map_err(VaultError::Io)
    }

    /// Sets or changes the master password. Only `vault-key.age` is rewritten,
    /// and leftovers of earlier rewrites are removed. The old password still
    /// opens any copy of the old `vault-key.age`: changing it revokes nothing.
    pub fn set_password(&self, password: &SecretText) -> Result<(), VaultError> {
        cipher::check_new_password(password)?;
        self.with_key(|key| {
            let wrapped = key.wrap(password)?;
            let _change = self.change_lock()?;
            write_private(&self.paths.key_file, &wrapped)?;
            self.sweep_key_leftovers()
        })
    }

    /// Removes the master password, only while the keychain holds this key.
    pub fn remove_password(&self, slot: &KeychainSlot) -> Result<(), VaultError> {
        self.with_key(|key| {
            let _change = self.change_lock()?;
            self.require_key_opens(key)?;
            if !slot.read()?.is_some_and(|stored| stored.same_as(key)) {
                return Err(VaultError::LastUnlockPath);
            }
            remove_if_present(&self.paths.key_file)
        })
    }

    /// Stores this device's key in the keychain.
    pub fn add_to_keychain(&self, slot: &KeychainSlot) -> Result<(), VaultError> {
        self.with_key(|key| {
            let _change = self.change_lock()?;
            slot.write(key)
        })
    }

    /// Removes the key from the keychain, only after `password` is shown to
    /// open this same key. The vault then needs the password after a restart.
    pub fn remove_from_keychain(
        &self,
        slot: &KeychainSlot,
        password: &SecretText,
    ) -> Result<(), VaultError> {
        self.with_key(|key| {
            // Everything from the check to the delete holds the lock, so a
            // concurrent removal of the password cannot slip in between.
            let _change = self.change_lock()?;
            self.require_key_opens(key)?;
            let wrapped = read_file(&self.paths.key_file, VaultError::LastUnlockPath)?;
            let opened = DeviceKey::unwrap(password, &wrapped)?;
            if !opened.same_as(key) {
                return Err(VaultError::LastUnlockPath);
            }
            slot.delete()
        })
    }

    /// Removes temporaries a crash left while rewriting `vault-key.age`. Each
    /// could hold the key wrapped by an old password. The caller holds the lock
    /// every writer of that file takes, so none of them is in use.
    fn sweep_key_leftovers(&self) -> Result<(), VaultError> {
        let (Some(folder), Some(name)) = (
            self.paths.key_file.parent(),
            self.paths.key_file.file_name(),
        ) else {
            return Ok(());
        };
        let prefix = format!(".{}.", name.to_string_lossy());
        for entry in std::fs::read_dir(folder).map_err(VaultError::Io)? {
            let path = entry.map_err(VaultError::Io)?.path();
            let leftover = path.file_name().is_some_and(|name| {
                let name = name.to_string_lossy();
                name.starts_with(&prefix) && name.ends_with(".tmp")
            });
            if leftover {
                remove_if_present(&path)?;
            }
        }
        Ok(())
    }

    fn refuse_existing(&self) -> Result<(), VaultError> {
        if self.exists()? {
            return Err(VaultError::AlreadyExists);
        }
        Ok(())
    }

    fn write_first_save(&self, key: &DeviceKey) -> Result<(), VaultError> {
        let sealed = seal(&Payload::new(key.recipient().to_owned()))?;
        write_private(&self.paths.file, &sealed)
    }

    fn set_key(&self, key: DeviceKey) {
        *self.key.write().unwrap_or_else(PoisonError::into_inner) = Some(key);
    }
}

fn remove_if_present(path: &Path) -> Result<(), VaultError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(VaultError::Io(error)),
    }
}
