use std::{collections::HashMap, process::Stdio, time::Duration};

use rmcp::{
    RoleClient,
    transport::{
        async_rw::AsyncRwTransport, streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
    client::{McpClient, McpClientError},
    registry::{McpServerConfig, McpTransportKind, ResolvedServerSecrets},
    session::{Operation, run_session, run_session_with_child},
    sse_transport::{LegacySseTransport, headers as sse_headers, streamable_headers},
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const MIN_TIMEOUT: Duration = Duration::from_secs(1);

impl McpClient {
    pub(super) async fn with_server(
        &self,
        server: &McpServerConfig,
        secrets: &ResolvedServerSecrets,
        operation: Operation,
        signal: &CancellationToken,
    ) -> Result<Value, McpClientError> {
        Box::pin(self.with_server_timeout(server, secrets, operation, DEFAULT_TIMEOUT, signal))
            .await
    }

    #[tracing::instrument(name = "mcp.call", skip_all, fields(method = operation.method()), err)]
    pub(super) async fn with_server_timeout(
        &self,
        server: &McpServerConfig,
        secrets: &ResolvedServerSecrets,
        operation: Operation,
        timeout: Duration,
        signal: &CancellationToken,
    ) -> Result<Value, McpClientError> {
        let prepared = self.prepared_operation(server, &operation).await?;
        let resolved = prepared
            .as_ref()
            .map(|(s, _)| super::registry::resolve_secrets(s, &self.environment))
            .transpose()
            .map_err(|_| {
                failure(
                    "plugin_secret_unavailable",
                    "Plugin credentials are unavailable.",
                    false,
                )
            })?;
        let server = prepared.as_ref().map(|(s, _)| s).unwrap_or(server);
        let secrets = resolved.as_ref().unwrap_or(secrets);
        if !server.enabled {
            return Err(failure(
                "mcp_server_disabled",
                "MCP server is disabled.",
                false,
            ));
        }
        if server.needs_secret() {
            return Err(failure(
                "mcp_secret_required",
                "MCP server needs a key.",
                false,
            ));
        }
        let timeout = timeout.max(MIN_TIMEOUT);
        match server.transport {
            McpTransportKind::Stdio => {
                Box::pin(self.with_stdio(server, secrets, operation, timeout, signal)).await
            }
            McpTransportKind::Http => {
                let url = parse_http_url(server.url.as_deref())?;
                let custom_headers = streamable_headers(&secrets.headers).map_err(|source| {
                    failure(
                        "mcp_server_unavailable",
                        "MCP server headers are invalid.",
                        false,
                    )
                    .with_source(source)
                })?;
                let mut config = StreamableHttpClientTransportConfig::with_uri(url.as_str());
                config.reinit_on_expired_session = false;
                config.custom_headers = custom_headers;
                let transport = super::logged_http::transport(config).map_err(http_client_error)?;
                Box::pin(run_session(transport, operation, timeout, signal)).await
            }
            McpTransportKind::Sse => {
                let url = parse_http_url(server.url.as_deref())?;
                let custom_headers = sse_headers(&secrets.headers).map_err(|source| {
                    failure(
                        "mcp_server_unavailable",
                        "MCP server headers are invalid.",
                        false,
                    )
                    .with_source(source)
                })?;
                let transport = LegacySseTransport::connect(
                    super::logged_http::client().map_err(http_client_error)?,
                    url,
                    custom_headers,
                    CancellationToken::new(),
                );
                Box::pin(run_session(transport, operation, timeout, signal)).await
            }
        }
    }

    async fn prepared_operation(
        &self,
        server: &McpServerConfig,
        operation: &Operation,
    ) -> Result<Option<super::overlay::LeasedConfig>, McpClientError> {
        if let Operation::CallTool { arguments, .. } = operation {
            if let Some(overlay) = self.overlay.clone().filter(|_| server.plugin.is_some()) {
                return self
                    .overlay_call(&server.id, overlay, Some(arguments.clone()))
                    .await;
            }
            return Ok(None);
        }
        self.overlay_execution(&server.id).await
    }
    async fn with_stdio(
        &self,
        server: &McpServerConfig,
        secrets: &ResolvedServerSecrets,
        operation: Operation,
        timeout: Duration,
        signal: &CancellationToken,
    ) -> Result<Value, McpClientError> {
        let mut command = Command::new(server.command.as_deref().unwrap_or_default());
        command
            .args(&server.args)
            .env_clear()
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        butler_platform::process_control::isolate_group(command.as_std_mut());
        if let Some(cwd) = &server.cwd {
            command.current_dir(cwd);
        }
        for (key, value) in if server.plugin.is_some() {
            butler_platform::command_sandbox::tool_environment(&self.environment)
                .into_iter()
                .collect()
        } else {
            default_stdio_environment(&self.environment)
        } {
            command.env(key, value);
        }
        for (key, value) in &secrets.env {
            command.env(key, value);
        }
        let mut child = command.spawn().map_err(|source| {
            failure(
                "mcp_server_unavailable",
                "MCP server could not be started.",
                false,
            )
            .with_source(source)
        })?;
        let _group = super::children::ChildGroup::register(&child).map_err(|source| {
            failure(
                "mcp_server_unavailable",
                "MCP server could not be contained.",
                false,
            )
            .with_source(source)
        })?;
        let Some(stdout) = child.stdout.take() else {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(failure(
                "mcp_server_unavailable",
                "MCP server could not be started.",
                false,
            ));
        };
        let Some(stdin) = child.stdin.take() else {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(failure(
                "mcp_server_unavailable",
                "MCP server could not be started.",
                false,
            ));
        };
        let transport = AsyncRwTransport::<RoleClient, _, _>::new_client(stdout, stdin);
        Box::pin(run_session_with_child(
            transport, operation, timeout, signal, child,
        ))
        .await
    }
}

fn default_stdio_environment(environment: &HashMap<String, String>) -> Vec<(String, String)> {
    butler_platform::process_control::BASELINE_ENVIRONMENT
        .iter()
        .filter_map(|key| {
            environment
                .get(*key)
                .filter(|value| !value.starts_with("()"))
                .map(|value| ((*key).to_owned(), value.clone()))
        })
        .collect()
}

pub(super) fn project_tools(server_id: &str, value: Option<&Value>) -> Value {
    let projected = value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())?;
            let mut item = json!({"name":name,"qualified_name":format!("{server_id}/{name}")});
            if let Some(description) = tool.get("description").and_then(Value::as_str) {
                item["description"] = Value::String(description.to_owned());
            }
            if let Some(schema) = tool.get("inputSchema").and_then(Value::as_object) {
                item["input_schema"] = Value::Object(schema.clone());
            }
            Some(item)
        })
        .collect();
    Value::Array(projected)
}

pub(super) fn project_resources(value: Option<&Value>) -> Value {
    let projected = value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|resource| {
            let uri = resource
                .get("uri")
                .and_then(Value::as_str)
                .filter(|uri| !uri.is_empty())?;
            let mut item = json!({
                "uri":uri,
                "name":resource.get("name").and_then(Value::as_str).unwrap_or(uri),
            });
            if let Some(description) = resource.get("description").and_then(Value::as_str) {
                item["description"] = Value::String(description.to_owned());
            }
            if let Some(mime_type) = resource.get("mimeType").and_then(Value::as_str) {
                item["mime_type"] = Value::String(mime_type.to_owned());
            }
            Some(item)
        })
        .collect();
    Value::Array(projected)
}

pub(super) fn project_templates(value: Option<&Value>) -> Value {
    let projected = value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|template| {
            let uri_template = template
                .get("uriTemplate")
                .and_then(Value::as_str)
                .filter(|uri| !uri.is_empty())?;
            let mut item = json!({
                "uri_template":uri_template,
                "name":template.get("name").and_then(Value::as_str).unwrap_or(uri_template),
            });
            if let Some(description) = template.get("description").and_then(Value::as_str) {
                item["description"] = Value::String(description.to_owned());
            }
            if let Some(mime_type) = template.get("mimeType").and_then(Value::as_str) {
                item["mime_type"] = Value::String(mime_type.to_owned());
            }
            Some(item)
        })
        .collect();
    Value::Array(projected)
}

impl McpTransportKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Stdio => "stdio",
            Self::Http => "http",
            Self::Sse => "sse",
        }
    }
}

fn parse_http_url(url: Option<&str>) -> Result<Url, McpClientError> {
    url.and_then(|value| Url::parse(value).ok())
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .ok_or_else(|| {
            failure(
                "mcp_server_config_invalid",
                "MCP server URL is invalid.",
                false,
            )
        })
}

pub(super) fn with_probe_error(mut base: Value, message: &str) -> Value {
    base["ok"] = Value::Bool(false);
    base["error"] = Value::String(message.to_owned());
    base
}

fn failure(code: &'static str, message: &'static str, attempted: bool) -> McpClientError {
    McpClientError::new(code, message, attempted)
}

fn http_client_error(source: reqwest::Error) -> McpClientError {
    failure(
        "mcp_server_unavailable",
        "MCP HTTP client unavailable.",
        false,
    )
    .with_source(source)
}
