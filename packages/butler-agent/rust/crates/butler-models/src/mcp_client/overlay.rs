//! Host-provided component data, independent of host manifest/storage types.
use super::{
    McpClient,
    client::{McpClientError, failure},
    registry::{McpRegistryError, McpServerConfig, normalize_server_config},
};
use serde_json::Value;
use std::sync::Arc;
/// Execution snapshot and an optional host-owned content lease.
pub struct PreparedOverlay {
    /// Resolved configuration.
    pub config: Value,
    /// Keeps immutable package content alive through the operation.
    pub lease: Option<Arc<dyn Send + Sync>>,
}
/// On-demand package server overlay. Snapshots never launch code or read secrets.
pub trait McpOverlay: Send + Sync {
    /// Enabled, trusted configurations, with namespaced ids and source metadata.
    fn servers(&self) -> Vec<Value>;
    /// Verify integrity and resolve approved credentials immediately before execution.
    /// Called on a blocking thread. Errors must contain no secret bytes.
    fn prepare(&self, id: &str) -> Result<Value, &'static str>;
    /// Acquire content for the lifetime of an operation, on a blocking thread.
    fn prepare_leased(&self, id: &str) -> Result<PreparedOverlay, &'static str> {
        self.prepare(id).map(|config| PreparedOverlay {
            config,
            lease: None,
        })
    }
}
type LeasedConfig = (McpServerConfig, Option<Arc<dyn Send + Sync>>);
impl McpClient {
    /// Attach a host registry without making the model crate depend on host types.
    pub fn with_overlay(mut self, overlay: Arc<dyn McpOverlay>) -> Self {
        self.overlay = Some(overlay);
        self
    }
    pub(super) fn overlay_servers(&self) -> Result<Vec<McpServerConfig>, McpRegistryError> {
        self.overlay
            .as_ref()
            .map(|o| o.servers())
            .unwrap_or_default()
            .iter()
            .map(config)
            .collect()
    }
    pub(super) async fn overlay_execution(
        &self,
        id: &str,
    ) -> Result<Option<LeasedConfig>, McpClientError> {
        if !id.contains('/') {
            return Ok(None);
        }
        let overlay = self
            .overlay
            .clone()
            .ok_or_else(|| failure("plugin_unavailable", "Plugin is unavailable.", false))?;
        let id = id.to_owned();
        let value = tokio::task::spawn_blocking(move || overlay.prepare_leased(&id))
            .await
            .map_err(|_| failure("plugin_unavailable", "Plugin is unavailable.", false))?
            .map_err(|code| failure(code, "Plugin execution refused.", false))?;
        config(&value.config)
            .map(|config| Some((config, value.lease)))
            .map_err(|_| failure("plugin_invalid", "Plugin server is invalid.", false))
    }
}
fn config(value: &Value) -> Result<McpServerConfig, McpRegistryError> {
    let mut config = normalize_server_config(value)?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| s.contains('/'))
        .ok_or(McpRegistryError::InvalidConfiguration)?;
    config.id = id.into();
    config.plugin = id.split_once('/').map(|(id, _)| id.to_owned());
    Ok(config)
}
