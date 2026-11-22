use butler_platform::secrets::SecretBackend;
use serde_json::{Value, json};

use super::McpClient;
use super::registry::{
    McpRegistryError, McpServerConfig, ResolvedServerSecrets, literal_slots,
    normalize_server_config, resolve_secrets, server_to_value,
};

impl McpClient {
    pub(super) async fn resolve(
        &self,
        server: &McpServerConfig,
    ) -> Result<ResolvedServerSecrets, McpRegistryError> {
        let mut server = server.clone();
        for (id, secret) in literal_slots(&mut server) {
            if let Some(backend) = secret.storage {
                secret.value = self
                    .secrets
                    .get(&id, backend)
                    .await
                    .map_err(McpRegistryError::SecretStore)?
                    .map(|value| value.expose().to_owned())
                    .unwrap_or_default();
            }
        }
        resolve_secrets(&server, &self.environment)
    }

    pub(super) async fn store_literals(
        &self,
        registry: &mut Value,
    ) -> Result<usize, McpRegistryError> {
        let mut moved = 0;
        for value in registry
            .get_mut("servers")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            let mut server = normalize_server_config(value)?;
            let before = moved;
            for (id, secret) in literal_slots(&mut server) {
                if !secret.value.is_empty() {
                    secret.storage = Some(
                        self.secrets
                            .put(&id, &secret.value)
                            .await
                            .map_err(McpRegistryError::SecretStore)?,
                    );
                    secret.value.clear();
                    moved += 1;
                }
            }
            if moved > before {
                *value = server_to_value(&server);
            }
        }
        Ok(moved)
    }

    pub(super) async fn drop_unreferenced(
        &self,
        old: &[(String, SecretBackend)],
        new: &[(String, SecretBackend)],
    ) {
        for (id, backend) in old {
            if !new.iter().any(|(new_id, _)| new_id == id)
                && let Err(error) = self.secrets.remove(id, *backend).await
            {
                butler_core::diagnostic!("[mcp] secret removal failed: {error}");
            }
        }
    }

    pub async fn move_typed_secrets(&self) -> Result<usize, McpRegistryError> {
        self.write_registry(|registry| Ok((registry, json!(null), false)))
            .await
            .map(|(_, moved)| moved)
    }
}
