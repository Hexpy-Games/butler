use std::time::Duration;
use std::{collections::HashMap, path::Path, path::PathBuf, sync::Arc};

use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    registry::{McpServerConfig, read_registry, redact_text, resolve_secrets},
    session::Operation,
    transport::{project_resources, project_templates, project_tools, with_probe_error},
};
#[derive(Clone)]
pub(crate) struct NativeMcpClient {
    pub(super) data_root: PathBuf,
    pub(super) environment: Arc<HashMap<String, String>>,
    pub(super) configuration_writes: Arc<crate::configuration::ConfigurationWrites>,
    pub(super) registry_path_guard: Arc<RegistryPathGuard>,
}

pub(crate) type RegistryPathGuard =
    dyn Fn(&Path, &Path) -> Result<(), String> + Send + Sync + 'static;

#[derive(Clone, Debug)]
pub(crate) struct McpClientError {
    pub code: &'static str,
    pub message: &'static str,
    pub attempted: bool,
}

impl NativeMcpClient {
    /// Test-only owner for isolated fixtures; production must supply a write path guard.
    #[cfg(test)]
    pub(crate) fn new(data_root: PathBuf, environment: HashMap<String, String>) -> Self {
        Self {
            data_root,
            environment: Arc::new(environment),
            configuration_writes: Arc::new(crate::configuration::ConfigurationWrites::new()),
            registry_path_guard: Arc::new(|_, _| Ok(())),
        }
    }

    pub(crate) fn with_registry_writer(
        data_root: PathBuf,
        environment: HashMap<String, String>,
        configuration_writes: Arc<crate::configuration::ConfigurationWrites>,
        registry_path_guard: Arc<RegistryPathGuard>,
    ) -> Self {
        Self {
            data_root,
            environment: Arc::new(environment),
            configuration_writes,
            registry_path_guard,
        }
    }

    pub(crate) async fn list_capabilities(
        &self,
        include_disabled: bool,
        signal: &CancellationToken,
    ) -> Result<Value, McpClientError> {
        let registry = read_registry(&self.data_root).map_err(|_| {
            failure(
                "mcp_registry_unavailable",
                "MCP server registry is unavailable.",
                false,
            )
        })?;
        let mut servers = Vec::new();
        for server in registry {
            if signal.is_cancelled() {
                return Err(failure(
                    "turn_cancelled",
                    "MCP discovery was cancelled.",
                    false,
                ));
            }
            if !include_disabled && !server.enabled {
                continue;
            }
            servers.push(Box::pin(self.probe_config(&server, signal)).await);
        }
        Ok(json!({"servers": servers}))
    }

    pub(crate) async fn probe_server(
        &self,
        server_id: &str,
        signal: &CancellationToken,
    ) -> Result<Value, McpClientError> {
        let server = self.find_server(server_id)?;
        Ok(Box::pin(self.probe_config(&server, signal)).await)
    }

    pub(crate) async fn describe_tool_schema(
        &self,
        server_id: &str,
        tool_name: &str,
        signal: &CancellationToken,
    ) -> Result<Option<Value>, McpClientError> {
        let server = self.find_server(server_id)?;
        if !server.enabled {
            return Err(failure(
                "mcp_server_disabled",
                "MCP server is disabled.",
                false,
            ));
        }
        let tool_name = tool_name.trim();
        if tool_name.is_empty() {
            return Ok(None);
        }
        let secrets = resolve_secrets(&server, &self.environment).map_err(|_| {
            failure(
                "mcp_server_unavailable",
                "MCP server credentials are unavailable.",
                false,
            )
        })?;
        if signal.is_cancelled() {
            return Err(failure(
                "turn_cancelled",
                "MCP schema lookup was cancelled.",
                false,
            ));
        }
        let result = Box::pin(self.with_server(
            &server,
            &secrets,
            Operation::DescribeTool {
                name: tool_name.to_owned(),
            },
            signal,
        ))
        .await?;
        if result.get("found") != Some(&Value::Bool(true)) {
            return Ok(None);
        }
        Ok(Some(json!({
            "server_id":server.id,
            "tool_name":tool_name,
            "description":result.get("description").and_then(Value::as_str),
            "input_schema":result.get("inputSchema").and_then(Value::as_object).cloned().unwrap_or_default(),
        })))
    }

    pub(crate) async fn call_tool(
        &self,
        server_id: &str,
        tool_name: &str,
        arguments: Map<String, Value>,
        signal: &CancellationToken,
    ) -> Result<Value, McpClientError> {
        Box::pin(self.call_tool_with_timeout(
            server_id,
            tool_name,
            arguments,
            Duration::from_secs(10),
            signal,
        ))
        .await
    }

    /// Per-operation timeout for tools whose public contract allows a longer
    /// bounded call than ordinary MCP discovery and execution.
    pub(crate) async fn call_tool_with_timeout(
        &self,
        server_id: &str,
        tool_name: &str,
        arguments: Map<String, Value>,
        timeout: Duration,
        signal: &CancellationToken,
    ) -> Result<Value, McpClientError> {
        let server = self.find_server(server_id)?;
        if !server.enabled {
            return Err(failure(
                "mcp_server_disabled",
                "MCP server is disabled.",
                false,
            ));
        }
        let tool_name = tool_name.trim();
        if tool_name.is_empty() {
            return Err(failure(
                "mcp_tool_name_required",
                "MCP tool name is required.",
                false,
            ));
        }
        let secrets = resolve_secrets(&server, &self.environment).map_err(|_| {
            failure(
                "mcp_server_unavailable",
                "MCP server credentials are unavailable.",
                false,
            )
        })?;
        if signal.is_cancelled() {
            return Err(failure(
                "turn_cancelled",
                "MCP tool call was cancelled.",
                false,
            ));
        }
        let request = Operation::CallTool {
            name: tool_name.to_owned(),
            arguments,
        };
        let result =
            Box::pin(self.with_server_timeout(&server, &secrets, request, timeout, signal)).await;
        match result {
            Ok(result) => {
                let is_error = result.get("isError") == Some(&Value::Bool(true));
                let error_message = result
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|item| item.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                let safe_error_message = redact_text(&error_message, &secrets.redact);
                let mut view = json!({
                    "ok": !is_error,
                    "server_id": server.id,
                    "tool_name": tool_name,
                    "result": result,
                });
                if is_error {
                    view["error"] = json!({
                        "code":"mcp_tool_failed",
                        "message":if error_message.is_empty() {
                            "The MCP tool reported a failure."
                        } else {
                            &safe_error_message
                        },
                    });
                }
                Ok(view)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) fn prepare_tool_call(
        &self,
        server_id: &str,
        tool_name: &str,
        arguments: Map<String, Value>,
    ) -> Result<(String, String, Map<String, Value>), McpClientError> {
        let server = self.find_server(server_id)?;
        if !server.enabled {
            return Err(failure(
                "mcp_server_disabled",
                "MCP server is disabled.",
                false,
            ));
        }
        let tool_name = tool_name.trim();
        if tool_name.is_empty() {
            return Err(failure(
                "mcp_tool_name_required",
                "MCP tool name is required.",
                false,
            ));
        }
        Ok((server.id.clone(), tool_name.to_owned(), arguments))
    }

    pub(crate) async fn read_resource(
        &self,
        server_id: &str,
        uri: &str,
        signal: &CancellationToken,
    ) -> Result<Value, McpClientError> {
        let server = self.find_server(server_id)?;
        if !server.enabled {
            return Err(failure(
                "mcp_server_disabled",
                "MCP server is disabled.",
                false,
            ));
        }
        let uri = uri.trim();
        if uri.is_empty() {
            return Err(failure(
                "mcp_resource_uri_required",
                "MCP resource uri is required.",
                false,
            ));
        }
        let secrets = resolve_secrets(&server, &self.environment).map_err(|_| {
            failure(
                "mcp_server_unavailable",
                "MCP server credentials are unavailable.",
                false,
            )
        })?;
        if signal.is_cancelled() {
            return Err(failure(
                "turn_cancelled",
                "MCP resource read was cancelled.",
                false,
            ));
        }
        let result = Box::pin(self.with_server(
            &server,
            &secrets,
            Operation::ReadResource {
                uri: uri.to_owned(),
            },
            signal,
        ))
        .await?;
        Ok(json!({"server_id":server.id,"uri":uri,"result":result}))
    }

    pub(super) fn find_server(&self, server_id: &str) -> Result<McpServerConfig, McpClientError> {
        let id = super::registry::normalize_server_id(server_id);
        read_registry(&self.data_root)
            .map_err(|_| {
                failure(
                    "mcp_registry_unavailable",
                    "MCP server registry is unavailable.",
                    false,
                )
            })?
            .into_iter()
            .find(|server| server.id == id)
            .ok_or_else(|| failure("mcp_server_not_found", "MCP server was not found.", false))
    }

    pub(super) async fn probe_config(
        &self,
        server: &McpServerConfig,
        signal: &CancellationToken,
    ) -> Value {
        let base = json!({
            "id": server.id,
            "display_name": server.display_name,
            "enabled": server.enabled,
            "transport": server.transport.as_str(),
            "tools": [],
            "resources": [],
            "resource_templates": [],
        });
        if signal.is_cancelled() {
            return with_probe_error(base, "MCP discovery was cancelled.");
        }
        let Ok(secrets) = resolve_secrets(server, &self.environment) else {
            return with_probe_error(base, "MCP server credentials are unavailable.");
        };
        let result = Box::pin(self.with_server(server, &secrets, Operation::Probe, signal)).await;
        match result {
            Ok(probe) => {
                json!({
                    "id":server.id,
                    "display_name":server.display_name,
                    "enabled":server.enabled,
                    "transport":server.transport.as_str(),
                    "tools":project_tools(&server.id, probe.get("tools")),
                    "resources":project_resources(probe.get("resources")),
                    "resource_templates":project_templates(probe.get("resourceTemplates")),
                    "ok":true,
                    "error":null,
                })
            }
            Err(error) => with_probe_error(base, error.message),
        }
    }
}

pub(super) fn failure(
    code: &'static str,
    message: &'static str,
    attempted: bool,
) -> McpClientError {
    McpClientError {
        code,
        message,
        attempted,
    }
}

#[cfg(test)]
mod tests;
