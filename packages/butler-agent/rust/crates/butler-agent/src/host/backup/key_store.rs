use std::path::Path;

use butler_backup::backup::{BackupKey, parse_recovery};
use butler_models::models::{SecretStoreFacts, credential_store_policy, fallback_file};
use butler_platform::secrets::{SecretKey, SecretStore};

use super::{Error, Result, error};

pub(super) fn uses_system(root: &Path) -> bool {
    credential_store_policy(root, SecretStoreFacts::for_data_root(root)).store == "system"
}

fn slot(root: &Path, system: bool) -> Result<(SecretStore, SecretKey)> {
    let scope = butler_vault::vault::keychain_key(root).map_err(Error::internal_from)?;
    let key = SecretKey::new(scope.service(), "backup-key").map_err(Error::internal_from)?;
    let store = if system {
        SecretStore::system().map_err(Error::internal_from)?
    } else {
        fallback_file(root)
    };
    Ok((store, key))
}

pub(super) fn load(root: &Path) -> Result<Option<BackupKey>> {
    load_from(root, uses_system(root))
}

pub(super) fn load_from(root: &Path, system: bool) -> Result<Option<BackupKey>> {
    let (store, key) = slot(root, system)?;
    store
        .get(&key)
        .map_err(Error::internal_from)?
        .map(|text| parse_recovery(text.expose()).map_err(super::backup_error))
        .transpose()
}

pub(super) fn store(root: &Path, key: &BackupKey) -> Result<()> {
    let (store, slot) = slot(root, uses_system(root))?;
    let text = key.recovery_text();
    store.set(&slot, &text).map_err(Error::internal_from)?;
    let written = store.get(&slot).map_err(Error::internal_from)?;
    if written
        .as_ref()
        .is_none_or(|value| value.expose() != text.as_str())
    {
        return Err(error(500, "io", "The recovery key could not be saved."));
    }
    Ok(())
}

pub(super) fn delete(root: &Path) -> Result<()> {
    delete_from(root, uses_system(root))
}

pub(super) fn delete_from(root: &Path, system: bool) -> Result<()> {
    let (store, slot) = slot(root, system)?;
    store.delete(&slot).map_err(Error::internal_from)?;
    Ok(())
}
