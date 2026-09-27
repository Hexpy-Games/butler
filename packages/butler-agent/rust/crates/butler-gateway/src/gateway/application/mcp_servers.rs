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
                .map_err(|error| {
                    GatewayApplicationError::public(
                        400,
                        "mcp_server_save_failed",
                        error.to_string(),
                    )
                    .with_source(error)
                })
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
                .map_err(|error| {
                    let status = if matches!(
                        error,
                        butler_models::mcp_client::McpRegistryError::ServerNotFound(_)
                    ) {
                        404
                    } else {
                        400
                    };
                    GatewayApplicationError::public(
                        status,
                        "mcp_server_update_failed",
                        error.to_string(),
                    )
                    .with_source(error)
                })
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
