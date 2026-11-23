//! Copy legacy secrets once when Butler Vault is turned on.
use crate::host::plugins::Plugins;
use butler_models::models::{self, FileOverride, SecretStoreFacts, vault_uses_system_store};
use butler_platform::{
    data_paths,
    secrets::{SecretStore, SecretText, sealed_available},
    sqlite,
};
use butler_vault::vault::{DECLINED_MARKER, KeychainSlot, SwitchReport, VaultError, shared};
use rusqlite::OpenFlags;
use std::{io, path::Path};

/// Turns Butler Vault on for `data_root`: creates or unlocks it with the
/// keychain key, copies every legacy secret once and writes the marker,
/// then clears a stored decline. Blocking.
pub(crate) fn enable(
    data_root: &Path,
    plugins: &Plugins,
    password: Option<SecretText>,
) -> Result<SwitchReport, VaultError> {
    let store = product_store(data_root);
    let slot = select_slot(data_root, store.as_ref())?;
    if slot.is_none() && password.is_none() {
        return Err(VaultError::NotSystemStore);
    }
    let db = sqlite::open_with_flags(
        data_root.join(data_paths::APP_DB),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| VaultError::Io(io::Error::other(error)))?;
    let vault = shared(data_root);
    let report = if let Some((slot, unlock)) = slot {
        vault.switch(&slot, unlock, store.as_ref(), || {
            let mut items = models::vault_legacy_items(data_root)?;
            items.extend(butler_gateway::gateway::vault_legacy_items(data_root, &db)?);
            items.extend(plugins.vault_legacy_items());
            Ok(items)
        })?
    } else if let Some(password) = password {
        vault.switch_with_password(&password, store.as_ref(), || {
            butler_gateway::gateway::vault_legacy_items(data_root, &db)
        })?
    } else {
        return Err(VaultError::NotSystemStore);
    };
    match std::fs::remove_file(data_root.join(DECLINED_MARKER)) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(error) => return Err(VaultError::Io(error)),
    }
    Ok(report)
}

fn product_store(data_root: &Path) -> Option<SecretStore> {
    let facts = SecretStoreFacts::for_data_root(data_root);
    if facts.file_override == FileOverride::Honored {
        None
    } else {
        SecretStore::system().ok()
    }
}

fn select_slot(
    data_root: &Path,
    store: Option<&SecretStore>,
) -> Result<Option<(KeychainSlot, &'static str)>, VaultError> {
    let facts = SecretStoreFacts::for_data_root(data_root);
    if let Some(store) = store
        && vault_uses_system_store(data_root, facts)
    {
        Ok(Some((
            KeychainSlot::new(store.clone(), data_root)?,
            "keychain",
        )))
    } else if facts.file_override != FileOverride::Honored && sealed_available() {
        Ok(Some((KeychainSlot::sealed(data_root)?, "sealed")))
    } else {
        Ok(None)
    }
}

pub(crate) fn product_slot(
    data_root: &Path,
) -> Result<Option<(KeychainSlot, &'static str)>, VaultError> {
    select_slot(data_root, product_store(data_root).as_ref())
}

pub(crate) fn restore_vault(
    data_root: &Path,
    staged: &Path,
    recovery_secret: &[u8; 32],
    unlock: &str,
) -> Result<(), VaultError> {
    let (slot, unlock) = match unlock {
        "keychain" => (
            KeychainSlot::new(SecretStore::system().map_err(VaultError::Store)?, data_root)?,
            "keychain",
        ),
        "sealed" => (KeychainSlot::sealed(data_root)?, "sealed"),
        _ => return Err(VaultError::NotSystemStore),
    };
    butler_vault::vault::rekey_restored(staged, recovery_secret, &slot, &data_root.join("auth"))?;
    shared(data_root).write_marker(unlock, 0)
}

/// Opens a vault that is in use once at start, so its keychain key is read
/// here and never in the middle of a request. A failure is logged; secrets
/// then answer "vault locked" until the next start.
pub(crate) async fn open_at_start(data_root: &Path) {
    let vault = shared(data_root);
    match tokio::task::spawn_blocking(move || vault.active()).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => butler_core::diagnostic!("[vault] open failed: {error}"),
        Err(error) => butler_core::diagnostic!("[vault] open failed: {error}"),
    }
}
