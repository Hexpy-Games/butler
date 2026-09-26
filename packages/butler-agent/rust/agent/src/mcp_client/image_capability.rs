use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::{
    client::{McpClientError, NativeMcpClient, failure},
    registry::server_capability_projection,
};

const SERVER_ID: &str = "zai-vision";
const TOOL_NAME: &str = "analyze_image";

impl NativeMcpClient {
    /// Probes the current enabled Z.AI Vision server and hashes the same
    /// route/server/schema facts frozen by the source image admission.
    pub(crate) async fn zai_vision_tool_capability_digest(
        &self,
        provider_id: &str,
        model_id: &str,
        credential_id: Option<&str>,
        signal: &CancellationToken,
    ) -> Result<String, McpClientError> {
        if provider_id != "zai" || model_id != "glm-5.2" {
            return Err(failure(
                "image_carrier_unverified",
                "Z.AI Vision is unavailable for this model.",
                false,
            ));
        }
        let server = self.find_server(SERVER_ID)?;
        if !server.enabled {
            return Err(failure(
                "mcp_server_disabled",
                "MCP server is disabled.",
                false,
            ));
        }
        let probe = Box::pin(self.probe_config(&server, signal)).await;
        if probe.get("ok") != Some(&Value::Bool(true)) {
            return Err(failure(
                "mcp_server_unavailable",
                "MCP server capabilities could not be verified.",
                false,
            ));
        }
        let schema = probe
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|tool| tool.get("name").and_then(Value::as_str) == Some(TOOL_NAME))
            .and_then(|tool| tool.get("input_schema"))
            .filter(|schema| schema.is_object())
            .filter(|schema| accepts_image_source_and_prompt(schema))
            .cloned()
            .ok_or_else(|| {
                failure(
                    "mcp_tool_schema_invalid",
                    "Z.AI Vision image tool schema could not be verified.",
                    false,
                )
            })?;
        let descriptor = json!({
            "route": {
                "provider_id": provider_id,
                "model_id": model_id,
                "credential_id": credential_id,
            },
            "server": server_capability_projection(&server),
            "tool": {"name": TOOL_NAME, "input_schema": schema},
        });
        let canonical =
            crate::json::canonical_json(&descriptor, crate::json::CanonicalKeyOrder::Utf16Lexical)
                .map_err(|_| {
                    failure(
                        "mcp_catalog_unavailable",
                        "MCP tool capability could not be prepared.",
                        false,
                    )
                })?;
        Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
    }
}

fn accepts_image_source_and_prompt(schema: &Value) -> bool {
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return false;
    };
    let Some(required) = schema.get("required").and_then(Value::as_array) else {
        return false;
    };
    ["image_source", "prompt"].into_iter().all(|name| {
        properties.contains_key(name) && required.iter().any(|value| value.as_str() == Some(name))
    })
}

#[cfg(test)]
mod tests {
    use super::accepts_image_source_and_prompt;
    use serde_json::json;

    #[test]
    fn image_tool_schema_requires_both_required_properties() {
        assert!(accepts_image_source_and_prompt(&json!({
            "type":"object",
            "properties":{"image_source":{"type":"string"},"prompt":{"type":"string"}},
            "required":["image_source","prompt"]
        })));
        assert!(!accepts_image_source_and_prompt(&json!({
            "properties":{"image_source":{},"prompt":{}},
            "required":["image_source"]
        })));
    }
}
