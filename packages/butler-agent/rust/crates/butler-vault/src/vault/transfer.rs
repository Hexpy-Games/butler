//! Password-protected export and import. An export is a standard age file that
//! the age CLI opens with the same password.

use super::VaultError;
use super::cipher;
use super::format::Payload;
use super::merge::merge;
use super::store::{Vault, now_ms, read_file, write_private};
use butler_platform::secrets::SecretText;
use std::path::Path;

/// The largest file an import reads. A vault is far smaller, so a wrong file
/// picked by mistake is refused before it is read into memory.
const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;

/// How far ahead of this clock an import's times may be: one day. A time far in
/// the future would beat every later local change.
const MAX_CLOCK_AHEAD_MS: u64 = 24 * 60 * 60 * 1000;

impl Vault {
    /// Writes every item and deletion to `destination`, openable only with
    /// `password`. It holds no recipients: an export never grants a device
    /// access to the vault it is imported into. It cannot go in the vault's own
    /// folder, where it could replace a vault file.
    pub fn export(&self, destination: &Path, password: &SecretText) -> Result<(), VaultError> {
        cipher::check_new_password(password)?;
        self.refuse_inside_vault(destination)?;
        let mut payload = self.read()?;
        payload.recipients.clear();
        let sealed = cipher::seal_with_password(password, &payload.to_json()?)?;
        write_private(destination, &sealed)
    }

    /// Merges an export into this vault in one save, by the rules of
    /// [`merge`], so an old export never deletes newer items. Returns whether
    /// anything changed; if not, nothing is written. Times over a day ahead of
    /// this clock are [`VaultError::TimeAhead`].
    pub fn import(&self, source: &Path, password: &SecretText) -> Result<bool, VaultError> {
        // A FIFO would block the read forever, with nothing to time it out.
        let metadata = std::fs::metadata(source).map_err(VaultError::Io)?;
        if !metadata.is_file() || metadata.len() > MAX_IMPORT_BYTES {
            return Err(VaultError::Refused);
        }
        let sealed = read_file(source, VaultError::Refused)?;
        let plaintext = cipher::open_with_password(password, &sealed)?;
        let incoming = Payload::from_json(&plaintext)?;
        refuse_times_ahead(&incoming, now_ms())?;
        self.save(|payload, _, now| {
            let mut merged = merge(payload, &incoming);
            // As the save would, or an expired deletion reads as a change.
            merged.prune_tombstones(now);
            let changed = merged.items != payload.items || merged.tombstones != payload.tombstones;
            *payload = merged;
            Ok(changed)
        })
    }

    fn refuse_inside_vault(&self, destination: &Path) -> Result<(), VaultError> {
        let real_folder = |path: &Path| {
            let folder = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            std::fs::canonicalize(folder).map_err(VaultError::Io)
        };
        if real_folder(destination)?.starts_with(real_folder(&self.paths.file)?) {
            return Err(VaultError::ExportInsideVault);
        }
        Ok(())
    }
}

fn refuse_times_ahead(payload: &Payload, now: u64) -> Result<(), VaultError> {
    let latest = now.saturating_add(MAX_CLOCK_AHEAD_MS);
    let edits = payload.items.iter().map(|item| item.updated_at);
    let deletions = payload.tombstones.iter().map(|tomb| tomb.deleted_at);
    if edits.chain(deletions).any(|time| time > latest) {
        return Err(VaultError::TimeAhead);
    }
    Ok(())
}
