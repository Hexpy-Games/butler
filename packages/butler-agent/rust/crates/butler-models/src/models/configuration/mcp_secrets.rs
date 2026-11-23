//! Typed MCP header/env secrets, kept where model API keys are kept.
use std::path::{Path, PathBuf};

use butler_platform::secrets::{SYSTEM_BACKEND, SecretBackend, SecretError, SecretKey, SecretText};
use butler_vault::vault::ItemKind;
use serde_json::Value;
use tokio::task::spawn_blocking;

use super::secret_store::{CredentialStoreError, ProviderSecrets};
use super::{sealed, secret_store, store_policy::SecretStoreFacts};

pub struct McpSecretStore {
    root: PathBuf,
    secrets: ProviderSecrets,
}

impl McpSecretStore {
    pub fn new(root: PathBuf) -> Self {
        let secrets = ProviderSecrets::new(SecretStoreFacts::for_data_root(&root));
        Self { root, secrets }
    }

    pub async fn put(&self, id: &str, value: &str) -> Result<SecretBackend, CredentialStoreError> {
        butler_log::register_secret_for(&format!("mcp:{id}"), value);
        let vault_id = mcp_vault_id(id);
        if sealed::is_enabled() {
            let value = SecretText::new(value.to_owned());
            spawn_blocking(move || {
                let mut map = sealed::read_map()?;
                map.insert(vault_id, value.expose().to_owned());
                sealed::write_map(&map)
            })
            .await
            .map_err(CredentialStoreError::Interrupted)??;
            return Ok(SecretBackend::FallbackFile);
        }
        if let Some(vault) = self.secrets.vault(&self.root).await? {
            let value = SecretText::new(value.to_owned());
            self.secrets
                .vault_call(move || vault.put(&vault_id, ItemKind::ApiKey, value))
                .await?;
            return Ok(SYSTEM_BACKEND);
        }
        let target = self.secrets.target(&self.root).await?;
        let backend = target.store.backend();
        let key = mcp_store_key(&self.root, backend, id)?;
        self.secrets.put(&target.store, &key, value).await?;
        Ok(backend)
    }

    pub async fn get(
        &self,
        id: &str,
        backend: SecretBackend,
    ) -> Result<Option<SecretText>, CredentialStoreError> {
        let vault_id = mcp_vault_id(id);
        let secret = if sealed::is_enabled() {
            spawn_blocking(move || Ok(sealed::read_map()?.remove(&vault_id)))
                .await
                .map_err(CredentialStoreError::Interrupted)?
                .map_err(CredentialStoreError::Sealed)?
                .map(SecretText::new)
        } else if let Some(vault) = self.secrets.vault(&self.root).await? {
            self.secrets
                .vault_call(move || vault.get(&vault_id))
                .await?
        } else {
            let store = self.secrets.holding(&self.root, backend).await?;
            let key = mcp_store_key(&self.root, backend, id)?;
            self.secrets.get(&store, &key).await?
        };
        if let Some(secret) = &secret {
            butler_log::register_secret_for(&format!("mcp:{id}"), secret.expose());
        }
        Ok(secret)
    }

    pub async fn remove(
        &self,
        id: &str,
        backend: SecretBackend,
    ) -> Result<(), CredentialStoreError> {
        let vault_id = mcp_vault_id(id);
        if sealed::is_enabled() {
            spawn_blocking(move || {
                let mut map = sealed::read_map()?;
                if map.remove(&vault_id).is_some() {
                    sealed::write_map(&map)?;
                }
                Ok::<_, sealed::SealedError>(())
            })
            .await
            .map_err(CredentialStoreError::Interrupted)??;
            return Ok(());
        }
        if let Some(vault) = self.secrets.vault(&self.root).await? {
            self.secrets
                .vault_call(move || vault.delete(&vault_id))
                .await?;
        }
        let store = self.secrets.holding(&self.root, backend).await?;
        let key = mcp_store_key(&self.root, backend, id)?;
        self.secrets.remove(&store, &key).await?;
        Ok(())
    }
}

pub(super) fn mcp_store_key(
    root: &Path,
    backend: SecretBackend,
    id: &str,
) -> Result<SecretKey, SecretError> {
    secret_store::key(root, backend, "mcp", id)
}

pub(super) fn mcp_vault_id(id: &str) -> String {
    format!("mcp/{id}")
}

pub fn clean_secret_key(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

pub fn is_literal_source(source: Option<&str>) -> bool {
    !matches!(source, Some("env" | "file"))
}

pub fn secret_id(server_id: &str, field: &str, key: &str) -> String {
    format!("{server_id}/{field}/{key}")
}

pub(crate) fn stored_secret_refs(
    data_root: &Path,
) -> Result<Vec<(String, SecretBackend)>, butler_core::configuration::ConfigError> {
    let registry = butler_core::configuration::read_json_object(
        &data_root.join("config").join("mcp-servers.json"),
    )?;
    Ok(stored_secret_refs_from_value(&registry))
}

pub(crate) fn stored_secret_refs_from_value(registry: &Value) -> Vec<(String, SecretBackend)> {
    let mut refs = Vec::new();
    for server in registry
        .get("servers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(server_id) = server.get("id").and_then(Value::as_str) else {
            continue;
        };
        for field in ["env", "headers"] {
            for item in server
                .get(field)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if !is_literal_source(item.get("source").and_then(Value::as_str)) {
                    continue;
                }
                let key = clean_secret_key(item.get("key").and_then(Value::as_str).unwrap_or(""));
                if key.is_empty() {
                    continue;
                }
                if let Some(backend) = item
                    .get("storage")
                    .and_then(Value::as_str)
                    .and_then(SecretBackend::from_name)
                {
                    refs.push((secret_id(server_id, field, &key), backend));
                }
            }
        }
    }
    refs
}
