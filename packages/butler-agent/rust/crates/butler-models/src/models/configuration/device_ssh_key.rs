use super::credential_admin::CredentialError;
use super::secret_store::CredentialStoreError;
use super::{ModelConfiguration, secret_store};
use crate::models::ModelCatalogError;
use butler_platform::{
    secrets::{SecretBackend, SecretText},
    secure_fs,
};
use butler_vault::vault::ItemKind;
use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path};
use tokio::task::spawn_blocking;

const RECORD: &str = "auth/device-ssh-key.json";
const KEY: &str = "device_ssh_key";
const ID: &str = "device";

pub struct DeviceSshKey {
    pub private: SecretText,
    pub public: String,
}

#[derive(Deserialize, Serialize)]
struct KeyRecord {
    home: String,
    public_key: String,
}

impl KeyRecord {
    fn read(root: &Path) -> io::Result<Option<Self>> {
        match fs::read(root.join(RECORD)) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
}

pub(super) fn system_key(
    root: &Path,
) -> io::Result<Option<(&'static str, &'static str, SecretBackend)>> {
    Ok(KeyRecord::read(root)?
        .and_then(|record| SecretBackend::from_name(&record.home))
        .filter(|backend| backend.is_system())
        .map(|backend| (KEY, ID, backend)))
}

fn record_error(source: io::Error) -> ModelCatalogError {
    ModelCatalogError::Storage {
        message: "Could not use the device SSH key record.",
        source: source.into(),
    }
}

impl ModelConfiguration {
    pub async fn device_ssh_key(
        &self,
        root: &Path,
        create: Option<DeviceSshKey>,
    ) -> Result<Option<DeviceSshKey>, CredentialError> {
        let write = self.configuration_writes.acquire_owned().await;
        let folder = root.to_owned();
        let record = spawn_blocking(move || KeyRecord::read(&folder))
            .await
            .map_err(CredentialStoreError::Interrupted)?
            .map_err(record_error)?;
        if let Some(record) = record {
            let private = if record.home == "vault" {
                let vault = self
                    .secrets
                    .vault(root)
                    .await?
                    .ok_or(CredentialError::SecretMissing)?;
                self.secrets.vault_call(move || vault.get(KEY)).await?
            } else {
                let backend = SecretBackend::from_name(&record.home)
                    .ok_or(CredentialStoreError::ForeignStore)?;
                let store = self.secrets.holding(root, backend).await?;
                let key = secret_store::key(root, backend, KEY, ID)
                    .map_err(CredentialStoreError::from)?;
                self.secrets.get(&store, &key).await?
            }
            .ok_or(CredentialError::SecretMissing)?;
            butler_log::register_secret(private.expose());
            return Ok(Some(DeviceSshKey {
                private,
                public: record.public_key,
            }));
        }
        let Some(key) = create else {
            return Ok(None);
        };
        butler_log::register_secret(key.private.expose());
        let home = if let Some(vault) = self.secrets.vault(root).await? {
            let value = SecretText::new(key.private.expose().to_owned());
            self.secrets
                .vault_call(move || vault.put(KEY, ItemKind::ApiKey, value))
                .await?;
            "vault"
        } else {
            let target = self.secrets.target(root).await?;
            let backend = target.store.backend();
            let id =
                secret_store::key(root, backend, KEY, ID).map_err(CredentialStoreError::from)?;
            self.secrets
                .put(&target.store, &id, key.private.expose())
                .await?;
            backend.as_str()
        };
        let record = KeyRecord {
            home: home.to_owned(),
            public_key: key.public.clone(),
        };
        let folder = root.to_owned();
        spawn_blocking(move || {
            let _write = write;
            secure_fs::create_private_dir_all(&folder.join("auth"))?;
            secure_fs::replace_private(
                &folder.join(RECORD),
                |file| Ok(serde_json::to_writer(file, &record)?),
                std::convert::identity,
            )
        })
        .await
        .map_err(CredentialStoreError::Interrupted)?
        .map_err(record_error)?;
        Ok(Some(key))
    }
}
