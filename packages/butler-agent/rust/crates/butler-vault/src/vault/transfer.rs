//! Password-protected export and import. An export is a standard age file that
//! the age CLI opens with the same password.

use super::VaultError;
use super::cipher;
use super::format::Payload;
use super::merge::merge;
use super::store::{Vault, read_file, write_private};
use butler_platform::secrets::SecretText;
use std::path::Path;

/// The largest file an import reads. A vault is far smaller, so a wrong file
/// picked by mistake is refused before it is read into memory.
const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;

impl Vault {
    /// Writes every item and deletion to `destination`, openable only with
    /// `password`. It holds no recipients: an export never grants a device
    /// access to the vault it is imported into.
    pub fn export(&self, destination: &Path, password: &SecretText) -> Result<(), VaultError> {
        cipher::check_new_password(password)?;
        let mut payload = self.read()?;
        payload.recipients.clear();
        let sealed = cipher::seal_with_password(password, &payload.to_json()?)?;
        write_private(destination, &sealed)
    }

    /// Merges an export into this vault in one save, by the rules of
    /// [`merge`], so an old export never deletes newer items. Returns whether
    /// anything changed; if not, nothing is written.
    pub fn import(&self, source: &Path, password: &SecretText) -> Result<bool, VaultError> {
        let size = std::fs::metadata(source).map_err(VaultError::Io)?.len();
        if size > MAX_IMPORT_BYTES {
            return Err(VaultError::Refused);
        }
        let sealed = read_file(source, VaultError::Refused)?;
        let plaintext = cipher::open_with_password(password, &sealed)?;
        let incoming = Payload::from_json(&plaintext)?;
        self.save(|payload, _, _| {
            let merged = merge(payload, &incoming);
            let changed = merged.items != payload.items || merged.tombstones != payload.tombstones;
            *payload = merged;
            Ok(changed)
        })
    }
}
