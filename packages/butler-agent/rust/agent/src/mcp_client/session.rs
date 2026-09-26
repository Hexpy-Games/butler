use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use rmcp::{
    RoleClient,
    model::{
        CallToolRequestParams, ClientCapabilities, ClientConfig, Implementation,
        PaginatedRequestParams, ReadResourceRequestParams,
    },
    service::{Peer, RunningService, serve_client_with_ct},
};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::client::{McpClientError, failure};

const MAX_PAGES: usize = 8;

pub(super) enum Operation {
    Probe,
    CallTool {
        name: String,
        arguments: Map<String, Value>,
    },
    DescribeTool {
        name: String,
    },
    ReadResource {
        uri: String,
    },
}

pub(super) async fn run_session<T, E, A>(
    transport: T,
    operation: Operation,
    timeout: Duration,
    turn_cancel: &CancellationToken,
) -> Result<Value, McpClientError>
where
    T: rmcp::transport::IntoTransport<RoleClient, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    run_session_inner(transport, operation, timeout, turn_cancel, None).await
}

pub(super) async fn run_session_with_child<T, E, A>(
    transport: T,
    operation: Operation,
    timeout: Duration,
    turn_cancel: &CancellationToken,
    child: tokio::process::Child,
) -> Result<Value, McpClientError>
where
    T: rmcp::transport::IntoTransport<RoleClient, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    run_session_inner(transport, operation, timeout, turn_cancel, Some(child)).await
}

async fn run_session_inner<T, E, A>(
    transport: T,
    operation: Operation,
    timeout: Duration,
    turn_cancel: &CancellationToken,
    mut child: Option<tokio::process::Child>,
) -> Result<Value, McpClientError>
where
    T: rmcp::transport::IntoTransport<RoleClient, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    if turn_cancel.is_cancelled() {
        if let Some(child) = child.take() {
            reap_child(child).await;
        }
        return Err(failure(
            "turn_cancelled",
            "MCP operation was cancelled.",
            false,
        ));
    }
    let connect_deadline = Instant::now() + timeout;
    let session_cancel = CancellationToken::new();
    let handler = ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new("butler-mcp-client", "1.0.0"),
    );
    let connecting = serve_client_with_ct(handler, transport, session_cancel.clone());
    let connected: Result<RunningService<RoleClient, ClientConfig>, McpClientError> = tokio::select! {
        biased;
        _ = turn_cancel.cancelled() => {
            session_cancel.cancel();
            Err(failure("turn_cancelled", "MCP operation was cancelled.", false))
        }
        result = tokio::time::timeout_at(connect_deadline.into(), connecting) => match result {
            Ok(Ok(client)) => Ok(client),
            Ok(Err(_)) => Err(failure("mcp_server_unavailable", "MCP server connection failed.", false)),
            Err(_) => {
                session_cancel.cancel();
                Err(failure("mcp_timeout", "MCP server connection timed out.", false))
            }
        }
    };
    let mut client = match connected {
        Ok(client) => client,
        Err(error) => {
            if let Some(child) = child.take() {
                reap_child(child).await;
            }
            return Err(error);
        }
    };

    let attempted = Arc::new(AtomicBool::new(false));
    let execute = execute_operation(client.peer(), operation, Arc::clone(&attempted));
    let operation_deadline = Instant::now() + timeout;
    let result = tokio::select! {
        biased;
        _ = turn_cancel.cancelled() => Err(failure(
            "turn_cancelled",
            "MCP operation was cancelled.",
            attempted.load(Ordering::Acquire),
        )),
        result = tokio::time::timeout_at(operation_deadline.into(), execute) => match result {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => Err(operation_failure(&error, attempted.load(Ordering::Acquire))),
            Err(_) => Err(failure(
                "mcp_timeout",
                "MCP operation timed out.",
                attempted.load(Ordering::Acquire),
            )),
        }
    };
    if result.is_err() {
        session_cancel.cancel();
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), client.close()).await;
    drop(client);
    if let Some(child) = child.take() {
        reap_child(child).await;
    }
    result
}

async fn reap_child(mut child: tokio::process::Child) {
    if tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .is_err()
    {
        let _ = child.start_kill();
        // A killed child must still be waited so its process handle is reaped.
        let _ = child.wait().await;
    }
}

async fn execute_operation(
    peer: &Peer<RoleClient>,
    operation: Operation,
    attempted: Arc<AtomicBool>,
) -> Result<Value, rmcp::ServiceError> {
    match operation {
        Operation::Probe => {
            let (tools, resources, templates) = tokio::join!(
                list_tools(peer),
                list_resources(peer),
                list_resource_templates(peer),
            );
            let tools = tools?;
            let resources = resources?;
            let templates = templates?;
            Ok(json!({"tools":tools,"resources":resources,"resourceTemplates":templates}))
        }
        Operation::CallTool { name, arguments } => {
            attempted.store(true, Ordering::Release);
            let params = CallToolRequestParams::new(name).with_arguments(arguments);
            let result = peer.call_tool(params).await?;
            serde_json::to_value(result).map_err(|_| rmcp::ServiceError::UnexpectedResponse)
        }
        Operation::DescribeTool { name } => {
            let tools = list_tools(peer).await?;
            let tool = tools
                .into_iter()
                .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name.as_str()));
            let Some(tool) = tool else {
                return Ok(json!({"found":false}));
            };
            Ok(json!({
                "found":true,
                "name":tool.get("name").and_then(Value::as_str).unwrap_or(""),
                "description":tool.get("description"),
                "inputSchema":tool.get("inputSchema").filter(|schema| schema.is_object()).cloned().unwrap_or_else(|| json!({})),
            }))
        }
        Operation::ReadResource { uri } => {
            let result = peer
                .read_resource(ReadResourceRequestParams::new(uri))
                .await?;
            serde_json::to_value(result).map_err(|_| rmcp::ServiceError::UnexpectedResponse)
        }
    }
}

async fn list_tools(peer: &Peer<RoleClient>) -> Result<Vec<Value>, rmcp::ServiceError> {
    let mut values = Vec::new();
    let mut cursor = None;
    for _ in 0..MAX_PAGES {
        let params = cursor
            .clone()
            .map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor)));
        let result = peer.list_tools(params).await?;
        values.extend(
            result
                .tools
                .into_iter()
                .filter_map(|tool| serde_json::to_value(tool).ok()),
        );
        cursor = result.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(values)
}

async fn list_resources(peer: &Peer<RoleClient>) -> Result<Vec<Value>, rmcp::ServiceError> {
    let mut values = Vec::new();
    let mut cursor = None;
    for _ in 0..MAX_PAGES {
        let params = cursor
            .clone()
            .map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor)));
        let result = match peer.list_resources(params).await {
            Ok(result) => result,
            Err(error) if method_not_found(&error) => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        values.extend(
            result
                .resources
                .into_iter()
                .filter_map(|resource| serde_json::to_value(resource).ok()),
        );
        cursor = result.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(values)
}

async fn list_resource_templates(
    peer: &Peer<RoleClient>,
) -> Result<Vec<Value>, rmcp::ServiceError> {
    let mut values = Vec::new();
    let mut cursor = None;
    for _ in 0..MAX_PAGES {
        let params = cursor
            .clone()
            .map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor)));
        let result = match peer.list_resource_templates(params).await {
            Ok(result) => result,
            Err(error) if method_not_found(&error) => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        values.extend(
            result
                .resource_templates
                .into_iter()
                .filter_map(|template| serde_json::to_value(template).ok()),
        );
        cursor = result.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(values)
}

fn method_not_found(error: &rmcp::ServiceError) -> bool {
    match error {
        rmcp::ServiceError::McpError(error) => {
            error.code == rmcp::model::ErrorCode::METHOD_NOT_FOUND
        }
        _ => false,
    }
}

fn operation_failure(error: &rmcp::ServiceError, attempted: bool) -> McpClientError {
    if attempted {
        failure(
            "mcp_tool_dispatch_uncertain",
            "MCP tool dispatch failed; the remote outcome may be unknown.",
            true,
        )
    } else if matches!(error, rmcp::ServiceError::Cancelled { .. }) {
        failure("turn_cancelled", "MCP operation was cancelled.", false)
    } else {
        failure(
            "mcp_server_unavailable",
            "MCP server request failed.",
            false,
        )
    }
}
