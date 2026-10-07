//! MCP server registry routes of the App application.

use super::*;

impl AppApplication {
    pub(super) fn create_mcp_server_owned(
        &self,
        input: serde_json::Value,
    ) -> ApplicationFuture<serde_json::Value> {
        let client = self.dependencies.mcp_client.clone();
        Box::pin(async move {
            client
                .upsert_server(input)
                .await
                .map(|server| serde_json::json!({"server": server}))
                .map_err(|error| mcp_save_error(error, "mcp_server_save_failed"))
        })
    }
    pub(super) fn update_mcp_server_owned(
        &self,
        id: String,
        input: serde_json::Value,
    ) -> ApplicationFuture<serde_json::Value> {
        let client = self.dependencies.mcp_client.clone();
        Box::pin(async move {
            client
                .update_server(id, input)
                .await
                .map(|server| serde_json::json!({"server": server}))
                .map_err(|error| mcp_save_error(error, "mcp_server_update_failed"))
        })
    }
    pub(super) fn probe_mcp_server_owned(
        &self,
        id: String,
        shutdown: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<serde_json::Value> {
        let client = self.dependencies.mcp_client.clone();
        Box::pin(async move {
            Box::pin(client.probe_server(&id, &shutdown))
                .await
                .map(|server| serde_json::json!({"servers": [server]}))
                .map_err(|error| {
                    let status = if error.code == "mcp_server_not_found" {
                        404
                    } else {
                        500
                    };
                    GatewayApplicationError::public(status, error.code, error.message)
                        .with_source(error)
                })
        })
    }
}

fn mcp_save_error(
    error: butler_models::mcp_client::McpRegistryError,
    fallback: &'static str,
) -> GatewayApplicationError {
    use butler_models::mcp_client::McpRegistryError;
    let code = match &error {
        McpRegistryError::ServerIdRequired => "mcp_server_id_required",
        McpRegistryError::CommandRequired => "mcp_command_required",
        McpRegistryError::UrlRequired(_) => "mcp_url_required",
        McpRegistryError::InvalidConfiguration => "mcp_config_invalid",
        McpRegistryError::SecretUnreadable(_) => "mcp_secret_unreadable",
        McpRegistryError::ServerNotFound(_) => "mcp_server_not_found",
        _ => fallback,
    };
    let status = if matches!(error, McpRegistryError::ServerNotFound(_)) {
        404
    } else {
        400
    };
    GatewayApplicationError::public(status, code, error.to_string()).with_source(error)
}
