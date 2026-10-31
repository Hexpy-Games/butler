//! Every secret in one encrypted file, `auth/vault.age`, in the standard age
//! format. Butler adds no cryptography of its own: age authenticates every
//! chunk and the header, so any changed byte refuses to open.
//!
//! `vault.age` is encrypted to X25519 recipients only, starting with this
//! device. Two unlock paths open the device's identity:
//!
//! - **Keychain:** one item in the OS credential store ([`KeychainSlot`]).
//! - **Master password:** `auth/vault-key.age`, the identity's text encrypted
//!   with age's password recipient. age refuses a password recipient next to
//!   any other recipient, so the password wraps the identity, not the vault.
//!
//! Changing the password rewrites only `vault-key.age`, and adding a device
//! adds a recipient to `vault.age`, so neither affects the other.
//!
//! X25519 stanzas do not name their recipient, so the recipient list lives in
//! the encrypted payload. age has no sender authentication: whoever holds a
//! recipient's public key can write a whole new valid file, so that key is
//! never published. A same-user process can also put back an older valid file;
//! `seq` is not checked against anything outside the file.
//!
//! The API is synchronous and blocks on files, the credential store and
//! scrypt; async callers use `spawn_blocking`. Reading never writes, and every
//! save follows a caller's change, so an idle vault writes nothing.

mod cipher;
mod device_key;
mod error;
mod format;
mod keychain;
mod merge;
mod store;
mod transfer;
mod unlock;

pub use cipher::MIN_PASSWORD_CHARS;
pub use error::VaultError;
pub use format::{FORMAT, Item, ItemKind, Payload, SecretValue, TOMBSTONE_RETENTION_MS, Tombstone};
pub use keychain::{KEYCHAIN_SERVICE, KeychainSlot};
pub use merge::merge;
pub use store::{NewItem, Vault, VaultPaths, VaultState};
