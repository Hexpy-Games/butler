//! Copy legacy secrets once when Butler Vault is turned on.
use crate::host::plugins::Plugins;
use butler_models::models::{self, SecretStoreFacts, vault_uses_system_store};
use butler_platform::{data_paths, secrets::SecretStore, sqlite};
use butler_vault::vault::{DECLINED_MARKER, SwitchReport, VaultError, shared};
use rusqlite::OpenFlags;
use std::{io, path::Path};

/// Turns Butler Vault on for `data_root`: creates or unlocks it with the
/// keychain key, copies every legacy secret once and writes the marker,
/// then clears a stored decline. Blocking.
pub(crate) fn enable(data_root: &Path, plugins: &Plugins) -> Result<SwitchReport, VaultError> {
    if !vault_uses_system_store(data_root, SecretStoreFacts::for_data_root(data_root)) {
        return Err(VaultError::NotSystemStore);
    }
    let store = SecretStore::system().map_err(VaultError::Store)?;
    let db = sqlite::open_with_flags(
        data_root.join(data_paths::APP_DB),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| VaultError::Io(io::Error::other(error)))?;
    let report = shared(data_root).switch(&store, || {
        let mut items = models::vault_legacy_items(data_root)?;
        items.extend(butler_gateway::gateway::vault_legacy_items(data_root, &db)?);
        items.extend(plugins.vault_legacy_items());
        Ok(items)
    })?;
    match std::fs::remove_file(data_root.join(DECLINED_MARKER)) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(error) => return Err(VaultError::Io(error)),
    }
    Ok(report)
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
