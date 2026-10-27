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
    /// Mechanical connector destination policy, checked before admission and dispatch.
    fn validate_tool(
        &self,
        _server: &str,
        _tool: &str,
        _arguments: &serde_json::Map<String, Value>,
    ) -> Result<(), &'static str> {
        Ok(())
    }
    /// Connected-source model tools use the same host owner as admin operations.
    fn connector_tool(
        &self,
        _action: String,
        _input: Value,
        _read_only: bool,
    ) -> butler_core::plugins::PluginFuture<'_> {
        Box::pin(async {
            Err(butler_core::plugins::connector_failure(
                "connectors_unavailable",
            ))
        })
    }
    /// Verify integrity and resolve approved credentials immediately before execution.
    /// Called on a blocking thread. Errors must contain no secret bytes.
    fn prepare(&self, id: &str) -> Result<Value, &'static str>;
    /// Account-scoped calls may add credentials after the ordinary verification.
    fn prepare_call(
        &self,
        id: &str,
        _arguments: &serde_json::Map<String, Value>,
    ) -> Result<PreparedOverlay, &'static str> {
        self.prepare_leased(id)
    }
    /// Acquire content for the lifetime of an operation, on a blocking thread.
    fn prepare_leased(&self, id: &str) -> Result<PreparedOverlay, &'static str> {
        self.prepare(id).map(|config| PreparedOverlay {
            config,
            lease: None,
        })
    }
}
pub(super) type LeasedConfig = (McpServerConfig, Option<Arc<dyn Send + Sync>>);
impl McpClient {
    pub fn validate_connector_destination(
        &self,
        server: &str,
        tool: &str,
        arguments: &serde_json::Map<String, Value>,
    ) -> Result<(), &'static str> {
        self.overlay
            .as_ref()
            .map_or(Ok(()), |o| o.validate_tool(server, tool, arguments))
    }
    pub(super) fn check_connector_destination(
        &self,
        server: &str,
        tool: &str,
        args: &serde_json::Map<String, Value>,
    ) -> Result<(), McpClientError> {
        self.validate_connector_destination(server, tool, args)
            .map_err(|code| failure(code, "Connector destination refused.", false))
    }
    pub async fn connector_tool(
        &self,
        action: String,
        input: Value,
        read_only: bool,
    ) -> Result<Value, butler_core::plugins::PluginError> {
        self.overlay
            .as_ref()
            .ok_or_else(|| butler_core::plugins::connector_failure("connectors_unavailable"))?
            .connector_tool(action, input, read_only)
            .await
    }
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
        self.overlay_call(id, overlay, None).await
    }
    pub(super) async fn overlay_call(
        &self,
        id: &str,
        overlay: Arc<dyn McpOverlay>,
        arguments: Option<serde_json::Map<String, Value>>,
    ) -> Result<Option<LeasedConfig>, McpClientError> {
        let id = id.to_owned();
        let value = tokio::task::spawn_blocking(move || match arguments {
            Some(args) => overlay.prepare_call(&id, &args),
            None => overlay.prepare_leased(&id),
        })
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
