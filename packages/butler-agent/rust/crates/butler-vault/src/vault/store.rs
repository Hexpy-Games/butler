//! Reading and saving `vault.age`. Each access reads and decrypts the file, so
//! plaintext is never long-lived in memory.

use super::VaultError;
use super::cipher;
use super::device_key::DeviceKey;
use super::format::Payload;
use butler_platform::secrets::{ChangeLock, SecretText};
use butler_platform::secure_fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{PoisonError, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How long a save waits for another process's save to finish.
const CHANGE_WAIT: Duration = Duration::from_secs(10);

/// The files of one vault, in one folder.
#[derive(Clone, Debug)]
pub struct VaultPaths {
    pub(super) file: PathBuf,
    pub(super) previous: PathBuf,
    pub(super) lock: PathBuf,
    pub(super) key_file: PathBuf,
}

impl VaultPaths {
    /// The vault of a data folder, under `auth/`, which sandboxed commands
    /// cannot read.
    pub fn in_data_root(data_root: &Path) -> Self {
        Self::in_folder(&data_root.join("auth"))
    }

    pub fn in_folder(folder: &Path) -> Self {
        Self {
            file: folder.join("vault.age"),
            previous: folder.join("vault.age.prev"),
            lock: folder.join("vault.age.lock"),
            key_file: folder.join("vault-key.age"),
        }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn previous(&self) -> &Path {
        &self.previous
    }

    /// The device identity wrapped by the master password.
    pub fn key_file(&self) -> &Path {
        &self.key_file
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultState {
    /// No vault here yet.
    Absent,
    /// A vault exists and no key is in memory.
    Locked,
    /// The key is in memory. The file can still refuse to open.
    Unlocked,
}

/// One item to add or replace.
#[derive(Debug)]
pub struct NewItem {
    pub id: String,
    pub kind: super::ItemKind,
    pub value: SecretText,
}

/// A vault and, while unlocked, the device key in memory. It starts locked.
pub struct Vault {
    pub(super) paths: VaultPaths,
    pub(super) key: RwLock<Option<DeviceKey>>,
}

impl Vault {
    pub fn new(paths: VaultPaths) -> Self {
        Self {
            paths,
            key: RwLock::new(None),
        }
    }

    pub fn state(&self) -> Result<VaultState, VaultError> {
        if !self.exists()? {
            return Ok(VaultState::Absent);
        }
        Ok(if self.key_guard().is_some() {
            VaultState::Unlocked
        } else {
            VaultState::Locked
        })
    }

    /// Wipes the key from memory. Everything but unlocking then refuses with
    /// [`VaultError::Locked`].
    pub fn lock(&self) {
        *self.key.write().unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// The whole decrypted payload.
    pub fn read(&self) -> Result<Payload, VaultError> {
        self.with_key(|key| self.read_with(key))
    }

    /// One item's secret; `None` when there is no such item.
    pub fn get(&self, id: &str) -> Result<Option<SecretText>, VaultError> {
        Ok(self
            .read()?
            .item(id)
            .map(|item| item.value.to_secret_text()))
    }

    pub fn put(&self, item: NewItem) -> Result<(), VaultError> {
        self.put_many(vec![item])
    }

    /// Adds or replaces items in one save: a batch of any size is one write.
    pub fn put_many(&self, items: Vec<NewItem>) -> Result<(), VaultError> {
        self.save(|payload, device, now| {
            for item in items {
                payload.put(item, device, now);
            }
            Ok(true)
        })
        .map(|_| ())
    }

    /// Deletes an item, leaving a tombstone. False, with no write, when there
    /// is no such item.
    pub fn delete(&self, id: &str) -> Result<bool, VaultError> {
        self.save(|payload, _, now| Ok(payload.remove(id, now)))
    }

    /// This device's public key, for another device to add as a recipient.
    /// Whoever holds it can write a valid vault file, so it must not be shown
    /// in the product until sync has signing.
    pub fn device_recipient(&self) -> Result<String, VaultError> {
        self.with_key(|key| Ok(key.recipient().to_owned()))
    }

    /// Adds a recipient: later saves are openable by that device too. The
    /// secrets and both unlock paths stay as they are.
    pub fn add_recipient(&self, recipient: &str) -> Result<(), VaultError> {
        recipient
            .parse::<age::x25519::Recipient>()
            .map_err(|_| VaultError::InvalidRecipient)?;
        self.save(|payload, _, _| {
            if payload.recipients.iter().any(|known| known == recipient) {
                return Ok(false);
            }
            payload.recipients.push(recipient.to_owned());
            Ok(true)
        })
        .map(|_| ())
    }

    /// Puts the previous copy back after `vault.age` refused to open, keeping
    /// the refused bytes beside it as `vault.age.damaged-<time>`. Explicit, so
    /// a changed file is never silently replaced by an older one.
    pub fn restore_previous(&self) -> Result<(), VaultError> {
        self.with_key(|key| {
            let _change = self.change_lock()?;
            let previous = read_file(&self.paths.previous, VaultError::NoPrevious)?;
            decode(key, &previous).map_err(|_| VaultError::NoPrevious)?;
            match read_file(&self.paths.file, VaultError::Absent) {
                Ok(current) => {
                    if decode(key, &current).is_ok() {
                        return Err(VaultError::NotDamaged);
                    }
                    let mut name = self.paths.file.clone().into_os_string();
                    name.push(format!(".damaged-{}", now_ms()));
                    write_private(Path::new(&name), &current)?;
                }
                Err(VaultError::Absent) => {}
                Err(error) => return Err(error),
            }
            write_private(&self.paths.file, &previous)
        })
    }

    /// A read-modify-write cycle under the cross-process lock. `change` says
    /// whether it changed anything; if not, nothing is written. A file that
    /// refuses to open is never overwritten, because reading it comes first.
    pub(super) fn save(
        &self,
        change: impl FnOnce(&mut Payload, &str, u64) -> Result<bool, VaultError>,
    ) -> Result<bool, VaultError> {
        self.with_key(|key| {
            let _change = self.change_lock()?;
            let current = self.read_current()?;
            let mut payload = decode(key, &current)?;
            let now = now_ms();
            if !change(&mut payload, &key.device_id(), now)? {
                return Ok(false);
            }
            payload.prune_tombstones(now);
            payload.seq = payload.seq.saturating_add(1);
            let sealed = seal(&payload)?;
            // The recipients come from the file, so a forged list could lock
            // this device out. Nothing is written unless this key can read it.
            decode(key, &sealed)?;
            write_private(&self.paths.previous, &current)?;
            write_private(&self.paths.file, &sealed)?;
            Ok(true)
        })
    }

    pub(super) fn with_key<T>(
        &self,
        work: impl FnOnce(&DeviceKey) -> Result<T, VaultError>,
    ) -> Result<T, VaultError> {
        let guard = self.key_guard();
        work(guard.as_ref().ok_or(VaultError::Locked)?)
    }

    fn key_guard(&self) -> std::sync::RwLockReadGuard<'_, Option<DeviceKey>> {
        self.key.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn read_with(&self, key: &DeviceKey) -> Result<Payload, VaultError> {
        decode(key, &self.read_current()?)
    }

    /// The file's bytes. With only the previous copy left, the vault is
    /// damaged, not absent, so creating cannot replace it.
    fn read_current(&self) -> Result<Vec<u8>, VaultError> {
        match read_file(&self.paths.file, VaultError::Absent) {
            Err(VaultError::Absent) if self.paths.previous.try_exists().unwrap_or(true) => {
                Err(VaultError::Refused)
            }
            result => result,
        }
    }

    /// Refuses a key that opens neither `vault.age` nor its previous copy, when
    /// either exists. Only the encryption is checked: a file in a newer format
    /// still belongs to this key.
    pub(super) fn require_key_opens(&self, key: &DeviceKey) -> Result<(), VaultError> {
        let mut found = false;
        for path in [&self.paths.file, &self.paths.previous] {
            match read_file(path, VaultError::Absent) {
                Ok(sealed) => {
                    if cipher::open_with(key.identity(), &sealed).is_ok() {
                        return Ok(());
                    }
                    found = true;
                }
                Err(VaultError::Absent) => {}
                Err(error) => return Err(error),
            }
        }
        if found {
            return Err(VaultError::Refused);
        }
        Ok(())
    }

    pub(super) fn exists(&self) -> Result<bool, VaultError> {
        Ok(self.paths.file.try_exists().map_err(VaultError::Io)?
            || self.paths.previous.try_exists().map_err(VaultError::Io)?)
    }

    pub(super) fn change_lock(&self) -> Result<ChangeLock, VaultError> {
        ChangeLock::acquire(&self.paths.lock, CHANGE_WAIT).map_err(VaultError::Io)
    }

    /// Makes the folder owner-only, as the owner-only secret file's writer does.
    pub(super) fn prepare_folder(&self) -> Result<(), VaultError> {
        if let Some(parent) = self
            .paths
            .file
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            secure_fs::create_private_dir_all(parent).map_err(VaultError::Io)?;
            secure_fs::protect_folder(parent)
                .transpose()
                .map_err(VaultError::Io)?;
        }
        Ok(())
    }
}

pub(super) fn decode(key: &DeviceKey, sealed: &[u8]) -> Result<Payload, VaultError> {
    Payload::from_json(&cipher::open_with(key.identity(), sealed)?)
}

pub(super) fn seal(payload: &Payload) -> Result<Vec<u8>, VaultError> {
    cipher::seal_to(&payload.recipients, &payload.to_json()?)
}

pub(super) fn read_file(path: &Path, missing: VaultError) -> Result<Vec<u8>, VaultError> {
    secure_fs::read_replaced_file(path).map_err(super::error::io_or(missing))
}

pub(super) fn write_private(path: &Path, bytes: &[u8]) -> Result<(), VaultError> {
    secure_fs::replace_private(path, |file| file.write_all(bytes), std::convert::identity)
        .map_err(VaultError::Io)
}

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}
