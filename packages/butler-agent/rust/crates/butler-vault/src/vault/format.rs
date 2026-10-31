//! The decrypted payload. It exists only in memory, never on disk.

use super::VaultError;
use butler_platform::secrets::SecretText;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashSet;
use std::fmt;
use std::io::{self, Write};
use zeroize::Zeroizing;

/// The payload format this build reads and writes. A new field needs a new
/// format: fields this build does not know refuse to open, because saving
/// would drop them.
pub const FORMAT: u32 = 1;

/// How long a deletion is remembered: 180 days. An export older than this can
/// bring a deleted item back.
pub const TOMBSTONE_RETENTION_MS: u64 = 180 * 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Signin,
    Card,
    Profile,
    ImportBackup,
    ApiKey,
}

/// An item's secret: the exact text its module stores. Wiped when dropped,
/// and never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretValue(Zeroizing<String>);

impl SecretValue {
    pub fn new(secret: SecretText) -> Self {
        Self(secret.into_zeroizing())
    }

    /// The secret itself; keep the borrow as short as possible.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn to_secret_text(&self) -> SecretText {
        SecretText::new(self.0.to_string())
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretValue(<redacted>)")
    }
}

impl Serialize for SecretValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SecretValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer).map(|text| Self(Zeroizing::new(text)))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    /// Unique across kinds.
    pub id: String,
    pub kind: ItemKind,
    /// Milliseconds since the Unix epoch.
    pub updated_at: u64,
    /// The device that wrote this version.
    pub device: String,
    pub value: SecretValue,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tombstone {
    pub id: String,
    /// Milliseconds since the Unix epoch.
    pub deleted_at: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Payload {
    pub format: u32,
    pub vault_id: String,
    /// One more on every save.
    pub seq: u64,
    /// Every public key a save encrypts to. X25519 stanzas do not name their
    /// recipient, so the file's header cannot supply this list. Empty in an
    /// export, which a password opens.
    pub recipients: Vec<String>,
    /// Sorted by id.
    pub items: Vec<Item>,
    /// Sorted by id.
    pub tombstones: Vec<Tombstone>,
}

/// Leaves out the recipients: whoever holds one can write a valid vault file.
impl fmt::Debug for Payload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Payload")
            .field("format", &self.format)
            .field("vault_id", &self.vault_id)
            .field("seq", &self.seq)
            .field("items", &self.items)
            .field("tombstones", &self.tombstones)
            .finish_non_exhaustive()
    }
}

impl Payload {
    pub(super) fn new(recipient: String) -> Self {
        Self {
            format: FORMAT,
            vault_id: uuid::Uuid::new_v4().to_string(),
            seq: 1,
            recipients: vec![recipient],
            items: Vec::new(),
            tombstones: Vec::new(),
        }
    }

    pub fn item(&self, id: &str) -> Option<&Item> {
        self.items.iter().find(|item| item.id == id)
    }

    /// Adds or replaces an item. Its time is past the version or deletion it
    /// replaces, so a local change wins even when the clock went backwards.
    pub(super) fn put(&mut self, new: super::NewItem, device: &str, now: u64) {
        let id = new.id;
        let replaced = self
            .item(&id)
            .map(|item| item.updated_at)
            .into_iter()
            .chain(self.tombstone(&id).map(|tomb| tomb.deleted_at))
            .max();
        let updated_at = replaced.map_or(now, |time| now.max(time.saturating_add(1)));
        self.items.retain(|item| item.id != id);
        self.tombstones.retain(|tomb| tomb.id != id);
        self.items.push(Item {
            id,
            kind: new.kind,
            updated_at,
            device: device.to_owned(),
            value: SecretValue::new(new.value),
        });
        self.items.sort_by(|a, b| a.id.cmp(&b.id));
    }

    /// Replaces an item with a tombstone; false when there is no such item.
    pub(super) fn remove(&mut self, id: &str, now: u64) -> bool {
        let Some(updated_at) = self.item(id).map(|item| item.updated_at) else {
            return false;
        };
        self.items.retain(|item| item.id != id);
        self.tombstones.push(Tombstone {
            id: id.to_owned(),
            deleted_at: now.max(updated_at),
        });
        self.tombstones.sort_by(|a, b| a.id.cmp(&b.id));
        true
    }

    /// Forgets deletions older than [`TOMBSTONE_RETENTION_MS`].
    pub fn prune_tombstones(&mut self, now: u64) {
        self.tombstones
            .retain(|tomb| now.saturating_sub(tomb.deleted_at) <= TOMBSTONE_RETENTION_MS);
    }

    fn tombstone(&self, id: &str) -> Option<&Tombstone> {
        self.tombstones.iter().find(|tomb| tomb.id == id)
    }

    pub(super) fn from_json(bytes: &[u8]) -> Result<Self, VaultError> {
        let payload: Self = serde_json::from_slice(bytes).map_err(|_| VaultError::Format)?;
        let mut seen = HashSet::new();
        let unique = payload.items.iter().all(|item| seen.insert(&item.id));
        if payload.format != FORMAT || !unique {
            return Err(VaultError::Format);
        }
        Ok(payload)
    }

    /// Measures first, so the buffer never grows, which would leave an unwiped
    /// copy behind.
    pub(super) fn to_json(&self) -> Result<Zeroizing<Vec<u8>>, VaultError> {
        let mut size = ByteCount(0);
        serde_json::to_writer(&mut size, self).map_err(|_| VaultError::Format)?;
        let mut json = Zeroizing::new(Vec::with_capacity(size.0));
        serde_json::to_writer(&mut *json, self).map_err(|_| VaultError::Format)?;
        Ok(json)
    }
}

struct ByteCount(usize);

impl Write for ByteCount {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
