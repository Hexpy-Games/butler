use super::{Plugins, Result, error, storage};
use butler_platform::secrets::{SecretKey, SecretStore, SecretText};
use butler_vault::vault::{ItemKind, LegacyItem, LegacySource, ProductVault, shared};
use std::{path::Path, sync::Arc};

/// Plugin and connector secrets: in the vault once this data folder switched, else the system store.
pub(super) enum Secrets {
    Vault(Arc<ProductVault>),
    System(SecretStore),
}

impl Secrets {
    pub(super) fn open(data_root: &Path) -> Result<Self> {
        let vault = shared(data_root);
        match vault.active() {
            Ok(true) => Ok(Self::Vault(vault)),
            Ok(false) => SecretStore::system()
                .map(Self::System)
                .map_err(|_| error("plugin_secret_store_unavailable")),
            Err(_) => Err(error("plugin_secret_store_unavailable")),
        }
    }

    pub(super) fn get(&self, key: &SecretKey) -> std::result::Result<Option<SecretText>, ()> {
        match self {
            Self::Vault(vault) => vault
                .get(&format!("plugin/{}", key.account()))
                .map_err(|_| ()),
            Self::System(store) => store.get(key).map_err(|_| ()),
        }
    }

    pub(super) fn set(&self, key: &SecretKey, value: &str) -> std::result::Result<(), ()> {
        match self {
            Self::Vault(vault) => vault
                .put(
                    &format!("plugin/{}", key.account()),
                    ItemKind::PluginSecret,
                    SecretText::new(value.to_owned()),
                )
                .map_err(|_| ()),
            Self::System(store) => store.set(key, value).map_err(|_| ()),
        }
    }

    pub(super) fn delete(&self, key: &SecretKey) -> std::result::Result<bool, ()> {
        match self {
            Self::Vault(vault) => vault
                .delete(&format!("plugin/{}", key.account()))
                .map_err(|_| ()),
            Self::System(store) => store.delete(key).map_err(|_| ()),
        }
    }
}

impl Plugins {
    pub(crate) fn vault_legacy_items(&self) -> Vec<LegacyItem> {
        let state = self.state.lock().clone();
        let mut keys = Vec::new();
        for plugin in state.registry.plugins.values() {
            for field in &plugin.approval.capabilities.secrets {
                if let Ok(key) = storage::key(&plugin.package.name, &field.key) {
                    keys.push(key);
                }
            }
        }
        for account in state.registry.accounts.values() {
            if let Ok(account_keys) = self.connectors.secret_keys(account) {
                keys.extend(account_keys);
            }
        }
        keys.into_iter()
            .map(|key| LegacyItem {
                id: format!("plugin/{}", key.account()),
                kind: ItemKind::PluginSecret,
                sources: vec![LegacySource::System(key)],
            })
            .collect()
    }
}
