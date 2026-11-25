//! Environment values live in the same secure store as the computer identity.
use super::{
    ModelConfiguration,
    computer_keys::read_homes,
    credential_admin::CredentialError,
    secret_store::{self, CredentialStoreError},
};
use butler_platform::secrets::{SecretBackend, SecretText};
use butler_vault::vault::ItemKind;
use std::{collections::BTreeMap, path::Path};

impl ModelConfiguration {
    pub async fn computer_environment(
        &self,
        id: &str,
        root: &Path,
    ) -> Result<BTreeMap<String, SecretText>, CredentialError> {
        let homes = read_homes(root).await?;
        let Some(home) = homes.get(id) else {
            return Ok(BTreeMap::new());
        };
        let item = if home == "vault" {
            let vault = self
                .secrets
                .vault(root)
                .await?
                .ok_or(CredentialError::SecretMissing)?;
            let item_id = format!("computer_env/{id}");
            self.secrets.vault_call(move || vault.get(&item_id)).await?
        } else {
            let backend =
                SecretBackend::from_name(home).ok_or(CredentialStoreError::ForeignStore)?;
            if backend == SecretBackend::FallbackFile {
                return Ok(BTreeMap::new());
            }
            let store = self.secrets.holding(root, backend).await?;
            let key = secret_store::key(root, backend, "computer_env", id)
                .map_err(CredentialStoreError::from)?;
            self.secrets.get(&store, &key).await?
        };
        let Some(item) = item else {
            return Ok(BTreeMap::new());
        };
        let values: BTreeMap<String, String> =
            serde_json::from_str(item.expose()).map_err(|_| {
                super::super::ModelCatalogError::rejected("Invalid stored computer environment.")
            })?;
        Ok(values
            .into_iter()
            .map(|(name, value)| {
                butler_log::register_secret_for(&format!("computer-env:{id}:{name}"), &value);
                (name, SecretText::new(value))
            })
            .collect())
    }

    pub async fn save_computer_environment(
        &self,
        id: &str,
        root: &Path,
        values: BTreeMap<String, SecretText>,
    ) -> Result<(), CredentialError> {
        let item = if values.is_empty() {
            None
        } else {
            self.computer_identity(id, root, true).await?;
            let values: BTreeMap<_, _> = values
                .iter()
                .map(|(name, value)| {
                    butler_log::register_secret_for(
                        &format!("computer-env:{id}:{name}"),
                        value.expose(),
                    );
                    (name, value.expose())
                })
                .collect();
            Some(SecretText::new(serde_json::to_string(&values).map_err(
                |_| super::super::ModelCatalogError::rejected("Invalid computer environment."),
            )?))
        };
        let _write = self.configuration_writes.acquire().await;
        let homes = read_homes(root).await?;
        if let Some(home) = homes.get(id) {
            self.write_environment_item(id, root, home, item).await?;
        } else if item.is_some() {
            return Err(CredentialError::SecretMissing);
        }
        Ok(())
    }

    pub(super) async fn write_environment_item(
        &self,
        id: &str,
        root: &Path,
        home: &str,
        item: Option<SecretText>,
    ) -> Result<(), CredentialError> {
        if home == "vault" {
            let vault = self
                .secrets
                .vault(root)
                .await?
                .ok_or(CredentialError::SecretMissing)?;
            let item_id = format!("computer_env/{id}");
            if let Some(item) = item {
                self.secrets
                    .vault_call(move || vault.put(&item_id, ItemKind::ApiKey, item))
                    .await?;
            } else {
                self.secrets
                    .vault_call(move || vault.delete(&item_id))
                    .await?;
            }
        } else {
            let backend =
                SecretBackend::from_name(home).ok_or(CredentialStoreError::ForeignStore)?;
            if backend == SecretBackend::FallbackFile {
                return if item.is_some() {
                    Err(CredentialError::ComputerEnvStoreUnavailable)
                } else {
                    Ok(())
                };
            }
            let store = self.secrets.holding(root, backend).await?;
            let key = secret_store::key(root, backend, "computer_env", id)
                .map_err(CredentialStoreError::from)?;
            if let Some(item) = item {
                self.secrets.put(&store, &key, item.expose()).await?;
            } else {
                self.secrets.remove(&store, &key).await?;
            }
        }
        Ok(())
    }
}
