use std::{collections::HashMap, process::Stdio, time::Duration};

use rmcp::{
    RoleClient,
    transport::{
        StreamableHttpClientTransport, async_rw::AsyncRwTransport,
        streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
    client::{McpClientError, NativeMcpClient},
    registry::{McpServerConfig, McpTransportKind, ResolvedServerSecrets},
    session::{Operation, run_session, run_session_with_child},
    sse_transport::{LegacySseTransport, headers as sse_headers, streamable_headers},
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const MIN_TIMEOUT: Duration = Duration::from_secs(1);

impl NativeMcpClient {
    pub(super) async fn with_server(
        &self,
        server: &McpServerConfig,
        secrets: &ResolvedServerSecrets,
        operation: Operation,
        signal: &CancellationToken,
    ) -> Result<Value, McpClientError> {
        self.with_server_timeout(server, secrets, operation, DEFAULT_TIMEOUT, signal)
            .await
    }

    pub(super) async fn with_server_timeout(
        &self,
        server: &McpServerConfig,
        secrets: &ResolvedServerSecrets,
        operation: Operation,
        timeout: Duration,
        signal: &CancellationToken,
    ) -> Result<Value, McpClientError> {
        let timeout = timeout.max(MIN_TIMEOUT);
        match server.transport {
            McpTransportKind::Stdio => {
                let mut command = Command::new(server.command.as_deref().unwrap_or_default());
                command
                    .args(&server.args)
                    .env_clear()
                    .kill_on_drop(true)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null());
                if let Some(cwd) = &server.cwd {
                    command.current_dir(cwd);
                }
                for (key, value) in default_stdio_environment(&self.environment) {
                    command.env(key, value);
                }
                for (key, value) in &secrets.env {
                    command.env(key, value);
                }
                let mut child = command.spawn().map_err(|_| {
                    failure(
                        "mcp_server_unavailable",
                        "MCP server could not be started.",
                        false,
                    )
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
                run_session_with_child(transport, operation, timeout, signal, child).await
            }
            McpTransportKind::Http => {
                let url = parse_http_url(server.url.as_deref())?;
                let custom_headers = streamable_headers(&secrets.headers).map_err(|_| {
                    failure(
                        "mcp_server_unavailable",
                        "MCP server headers are invalid.",
                        false,
                    )
                })?;
                let mut config = StreamableHttpClientTransportConfig::with_uri(url.as_str());
                config.reinit_on_expired_session = false;
                config.custom_headers = custom_headers;
                let transport = StreamableHttpClientTransport::from_config(config);
                run_session(transport, operation, timeout, signal).await
            }
            McpTransportKind::Sse => {
                let url = parse_http_url(server.url.as_deref())?;
                let custom_headers = sse_headers(&secrets.headers).map_err(|_| {
                    failure(
                        "mcp_server_unavailable",
                        "MCP server headers are invalid.",
                        false,
                    )
                })?;
                let transport = LegacySseTransport::connect(
                    reqwest::Client::new(),
                    url,
                    custom_headers,
                    CancellationToken::new(),
                );
                run_session(transport, operation, timeout, signal).await
            }
        }
    }
}

fn default_stdio_environment(environment: &HashMap<String, String>) -> Vec<(String, String)> {
    #[cfg(windows)]
    const ALLOWED: &[&str] = &[
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERNAME",
        "USERPROFILE",
        "PROGRAMFILES",
    ];
    #[cfg(not(windows))]
    const ALLOWED: &[&str] = &["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

    ALLOWED
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
    McpClientError {
        code,
        message,
        attempted,
    }
}
