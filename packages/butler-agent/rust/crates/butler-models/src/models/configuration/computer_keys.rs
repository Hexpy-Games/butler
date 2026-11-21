//! Computer identities use the model key store selected when the computer first connects.
use super::credential_admin::CredentialError;
use super::secret_store::CredentialStoreError;
use super::{ModelConfiguration, sealed, secret_store};
use crate::models::ModelCatalogError;
use butler_platform::{
    secrets::{SecretBackend, SecretText},
    secure_fs,
};
use butler_vault::vault::ItemKind;
use std::{collections::BTreeMap, fs, io, path::Path};
use tokio::task::spawn_blocking;

const HOMES: &str = "auth/computer-key-homes.json";

pub(super) fn homes(root: &Path) -> io::Result<BTreeMap<String, String>> {
    match fs::read(root.join(HOMES)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error),
    }
}

impl ModelConfiguration {
    pub async fn computer_identity(
        &self,
        id: &str,
        root: &Path,
    ) -> Result<SecretText, CredentialError> {
        let _write = self.configuration_writes.acquire().await;
        let folder = root.to_owned();
        let file_error = |source: io::Error| ModelCatalogError::Storage {
            message: "Could not use the computer key homes file.",
            source: source.into(),
        };
        let mut homes = spawn_blocking(move || homes(&folder))
            .await
            .map_err(CredentialStoreError::Interrupted)?
            .map_err(file_error)?;
        let vault_id = format!("computer_key/{id}");
        let identity = if let Some(home) = homes.get(id) {
            if home == "vault" {
                let vault = self
                    .secrets
                    .vault(root)
                    .await?
                    .ok_or(CredentialError::SecretMissing)?;
                self.secrets
                    .vault_call(move || vault.get(&vault_id))
                    .await?
            } else {
                let backend =
                    SecretBackend::from_name(home).ok_or(CredentialStoreError::ForeignStore)?;
                let store = self.secrets.holding(root, backend).await?;
                let key = secret_store::key(root, backend, "computer_key", id)
                    .map_err(CredentialStoreError::from)?;
                self.secrets.get(&store, &key).await?
            }
            .ok_or(CredentialError::SecretMissing)?
        } else {
            let identity = sealed::new_identity();
            let home = if let Some(vault) = self.secrets.vault(root).await? {
                let value = SecretText::new(identity.expose().to_owned());
                self.secrets
                    .vault_call(move || vault.put(&vault_id, ItemKind::ApiKey, value))
                    .await?;
                "vault"
            } else {
                let target = self.secrets.target(root).await?;
                let backend = target.store.backend();
                let key = secret_store::key(root, backend, "computer_key", id)
                    .map_err(CredentialStoreError::from)?;
                self.secrets
                    .put(&target.store, &key, identity.expose())
                    .await?;
                backend.as_str()
            };
            homes.insert(id.to_owned(), home.to_owned());
            let folder = root.to_owned();
            spawn_blocking(move || {
                secure_fs::create_private_dir_all(&folder.join("auth"))?;
                secure_fs::replace_private(
                    &folder.join(HOMES),
                    |file| Ok(serde_json::to_writer(file, &homes)?),
                    std::convert::identity,
                )
            })
            .await
            .map_err(CredentialStoreError::Interrupted)?
            .map_err(file_error)?;
            identity
        };
        butler_log::register_secret(identity.expose());
        Ok(identity)
    }

    pub async fn delete_computer_identity(
        &self,
        id: &str,
        root: &Path,
    ) -> Result<(), CredentialError> {
        let _write = self.configuration_writes.acquire().await;
        let folder = root.to_owned();
        let file_error = |source: io::Error| ModelCatalogError::Storage {
            message: "Could not use the computer key homes file.",
            source: source.into(),
        };
        let mut homes = spawn_blocking(move || homes(&folder))
            .await
            .map_err(CredentialStoreError::Interrupted)?
            .map_err(file_error)?;
        let Some(home) = homes.remove(id) else {
            return Ok(());
        };
        if home == "vault" {
            let vault = self
                .secrets
                .vault(root)
                .await?
                .ok_or(CredentialError::SecretMissing)?;
            let vault_id = format!("computer_key/{id}");
            self.secrets
                .vault_call(move || vault.delete(&vault_id))
                .await?;
        } else {
            let backend =
                SecretBackend::from_name(&home).ok_or(CredentialStoreError::ForeignStore)?;
            let store = self.secrets.holding(root, backend).await?;
            let key = secret_store::key(root, backend, "computer_key", id)
                .map_err(CredentialStoreError::from)?;
            self.secrets.remove(&store, &key).await?;
        }
        let path = root.join(HOMES);
        spawn_blocking(move || {
            secure_fs::replace_private(
                &path,
                |file| Ok(serde_json::to_writer(file, &homes)?),
                std::convert::identity,
            )
        })
        .await
        .map_err(CredentialStoreError::Interrupted)?
        .map_err(file_error)?;
        Ok(())
    }
}
